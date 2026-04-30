use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_LENGTH};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};
use tauri::Emitter;
use zip::ZipArchive;

const GAME_FOLDER_NAME: &str = "Slay the Spire 2";
const GAME_EXECUTABLE_CANDIDATES: [&str; 2] = ["Slay the Spire 2.exe", "SlayTheSpire2.exe"];
const COMMON_STEAM_PATHS: [&str; 4] = [
    "Steam/steamapps/common",
    "SteamLibrary/steamapps/common",
    "Program Files (x86)/Steam/steamapps/common",
    "Program Files/Steam/steamapps/common",
];
const DOWNLOAD_ARCHIVE_NAME: &str = "mods.zip";
const BACKUP_DIR_PREFIX: &str = "mods_backup_";
const MODS_DIR_NAME: &str = "mods";
const USER_AGENT: &str = "sts2-mod-sync/1.0";
const API_TIMEOUT_SECS: u64 = 15;
const DOWNLOAD_TIMEOUT_SECS: u64 = 120;
const CONNECT_TIMEOUT_SECS: u64 = 8;

const GITHUB_API_MIRRORS: [&str; 2] = [
    "https://api.github.com",
    "https://api.ghproxy.cc",
];

const GITHUB_DOWNLOAD_MIRRORS: [&str; 3] = [
    "",
    "https://ghproxy.cc/",
    "https://gh-proxy.com/",
];

#[derive(Deserialize)]
struct ReleaseResponse {
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub phase: String,
}

#[derive(Serialize)]
pub struct BackupInfo {
    pub name: String,
    pub size_bytes: u64,
}

fn ensure_game_directory(game_directory: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(game_directory);
    if !path.exists() || !path.is_dir() {
        return Err("游戏目录不存在。".to_string());
    }
    Ok(path)
}

fn path_to_string(path: &Path) -> String {
    let s = path.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    let s = s.replace('/', "\\");
    s
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| {
            format!("删除目录失败：{}（{}）", path_to_string(path), error)
        })
    } else {
        fs::remove_file(path).map_err(|error| {
            format!("删除文件失败：{}（{}）", path_to_string(path), error)
        })
    }
}

fn parse_repository_url(repository_url: &str) -> Result<(String, String), String> {
    let url = Url::parse(repository_url.trim()).map_err(|_| "仓库地址格式不正确。".to_string())?;

    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("仓库地址必须是 GitHub 链接。".to_string());
    }

    if url.host_str() != Some("github.com") {
        return Err("仓库地址必须是 GitHub 链接。".to_string());
    }

    let parts: Vec<_> = url
        .path_segments()
        .ok_or_else(|| "仓库地址格式不正确。".to_string())?
        .filter(|segment| !segment.is_empty())
        .collect();

    if parts.len() < 2 {
        return Err("仓库地址格式不正确。".to_string());
    }

    Ok((parts[0].to_string(), parts[1].to_string()))
}

fn build_api_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(API_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("创建网络请求客户端失败：{}", error))
}

fn build_download_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("创建网络请求客户端失败：{}", error))
}

fn get_latest_release_asset_by_owner(owner: &str, repo: &str) -> Result<ReleaseAsset, String> {
    let client = build_api_client()?;
    let mut last_error = String::new();

    for api_base in GITHUB_API_MIRRORS {
        let api_url = format!("{api_base}/repos/{owner}/{repo}/releases/latest");
        let result = client
            .get(&api_url)
            .header(ACCEPT, "application/vnd.github+json")
            .send();

        let response = match result {
            Ok(resp) => resp,
            Err(error) => {
                last_error = format!("{api_base} 请求失败：{error}");
                continue;
            }
        };

        if response.status().as_u16() == 404 {
            return Err("没有找到最新 release。".to_string());
        }

        if !response.status().is_success() {
            last_error = format!("{api_base} 返回 HTTP {}。", response.status());
            continue;
        }

        let payload: ReleaseResponse = response
            .json()
            .map_err(|error| format!("解析 GitHub release 响应失败：{}", error))?;

        return payload
            .assets
            .into_iter()
            .find(|asset| asset.name == DOWNLOAD_ARCHIVE_NAME)
            .ok_or_else(|| "最新 release 中没有找到 mods.zip。".to_string());
    }

    Err(format!("获取最新 release 失败（所有镜像均不可用）：{last_error}"))
}

fn download_asset(
    download_url: &str,
    target_path: &Path,
    on_progress: &dyn Fn(u64, u64),
) -> Result<(), String> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("创建目录失败：{}（{}）", path_to_string(parent), error)
        })?;
    }

    let client = build_download_client()?;
    let mut last_error = String::new();

    for mirror_prefix in GITHUB_DOWNLOAD_MIRRORS {
        let url = if mirror_prefix.is_empty() {
            download_url.to_string()
        } else {
            format!("{mirror_prefix}{download_url}")
        };

        let source_label = if mirror_prefix.is_empty() {
            "直连"
        } else {
            mirror_prefix
        };

        let result = client.get(&url).send();
        let mut response = match result {
            Ok(resp) => resp,
            Err(error) => {
                last_error = format!("{source_label} 下载失败：{error}");
                continue;
            }
        };

        if !response.status().is_success() {
            last_error = format!("{source_label} 返回 HTTP {}。", response.status());
            continue;
        }

        let total = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);

        let mut file = File::create(target_path).map_err(|error| {
            format!("创建文件失败：{}（{}）", path_to_string(target_path), error)
        })?;

        let mut downloaded: u64 = 0;
        let mut buffer = [0u8; 8192];
        loop {
            let bytes_read = response
                .read(&mut buffer)
                .map_err(|error| format!("读取下载数据失败：{}", error))?;
            if bytes_read == 0 {
                break;
            }
            file.write_all(&buffer[..bytes_read])
                .map_err(|error| format!("写入 mods.zip 失败：{}", error))?;
            downloaded += bytes_read as u64;
            on_progress(downloaded, total);
        }

        return Ok(());
    }

    Err(format!(
        "下载 mods.zip 失败（所有镜像均不可用）：{last_error}"
    ))
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(meta) = p.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

fn extract_zip_to_directory(archive_path: &Path, target_directory: &Path) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|error| format!("打开压缩包失败：{}（{}）", path_to_string(archive_path), error))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("读取压缩包失败：{}", error))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取压缩包内容失败：{}", error))?;
        let enclosed_name = entry
            .enclosed_name()
            .ok_or_else(|| "压缩包包含非法路径。".to_string())?;
        let output_path = target_directory.join(enclosed_name);

        if entry.is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| {
                format!("创建目录失败：{}（{}）", path_to_string(&output_path), error)
            })?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("创建目录失败：{}（{}）", path_to_string(parent), error)
            })?;
        }

        let mut output_file = File::create(&output_path).map_err(|error| {
            format!("创建文件失败：{}（{}）", path_to_string(&output_path), error)
        })?;
        io::copy(&mut entry, &mut output_file).map_err(|error| {
            format!("解压文件失败：{}（{}）", path_to_string(&output_path), error)
        })?;
    }

    Ok(())
}

fn resolve_extraction_source(extracted_root: &Path) -> Result<PathBuf, String> {
    let mut children = Vec::new();
    for entry in fs::read_dir(extracted_root).map_err(|error| {
        format!("读取解压目录失败：{}（{}）", path_to_string(extracted_root), error)
    })? {
        let entry = entry.map_err(|error| {
            format!("读取解压目录项失败：{}（{}）", path_to_string(extracted_root), error)
        })?;
        children.push(entry.path());
    }

    if children.len() == 1 && children[0].is_dir() {
        let file_name = children[0]
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "解压后的目录名称无效。".to_string())?;
        if file_name.eq_ignore_ascii_case(MODS_DIR_NAME) {
            return Ok(children.remove(0));
        }
    }

    Ok(extracted_root.to_path_buf())
}

fn extract_archive_to_mods(archive_path: &Path, game_directory: &Path) -> Result<PathBuf, String> {
    let mods_directory = game_directory.join(MODS_DIR_NAME);
    let extract_directory = game_directory.join("mods.__extract__");
    let incoming_directory = game_directory.join("mods.__incoming__");
    let previous_directory = game_directory.join("mods.__previous__");

    remove_path_if_exists(&extract_directory)?;
    fs::create_dir_all(&extract_directory).map_err(|error| {
        format!("创建目录失败：{}（{}）", path_to_string(&extract_directory), error)
    })?;

    extract_zip_to_directory(archive_path, &extract_directory)?;

    let source_root = resolve_extraction_source(&extract_directory)?;

    let has_content = fs::read_dir(&source_root)
        .map_err(|error| format!("读取解压目录失败：{}（{}）", path_to_string(&source_root), error))?
        .next()
        .is_some();
    if !has_content {
        remove_path_if_exists(&extract_directory)?;
        return Err("mods.zip 中没有可用内容。".to_string());
    }

    remove_path_if_exists(&incoming_directory)?;

    if source_root == extract_directory {
        fs::rename(&extract_directory, &incoming_directory).map_err(|error| {
            format!("移动目录失败：{}（{}）", path_to_string(&extract_directory), error)
        })?;
    } else {
        fs::rename(&source_root, &incoming_directory).map_err(|error| {
            format!("移动目录失败：{}（{}）", path_to_string(&source_root), error)
        })?;
        let _ = remove_path_if_exists(&extract_directory);
    }

    remove_path_if_exists(&previous_directory)?;

    if mods_directory.exists() {
        fs::rename(&mods_directory, &previous_directory).map_err(|error| {
            format!(
                "移动目录失败：{} -> {}（{}）",
                path_to_string(&mods_directory),
                path_to_string(&previous_directory),
                error
            )
        })?;
    }

    if let Err(error) = fs::rename(&incoming_directory, &mods_directory) {
        if previous_directory.exists() {
            let _ = fs::rename(&previous_directory, &mods_directory);
        }
        return Err(format!(
            "移动目录失败：{} -> {}（{}）",
            path_to_string(&incoming_directory),
            path_to_string(&mods_directory),
            error
        ));
    }

    remove_path_if_exists(&previous_directory)?;
    Ok(mods_directory)
}

fn is_valid_game_directory(path: &Path) -> bool {
    if !path.exists() || !path.is_dir() {
        return false;
    }

    if GAME_EXECUTABLE_CANDIDATES
        .iter()
        .any(|executable| path.join(executable).exists())
    {
        return true;
    }

    path.join(MODS_DIR_NAME).exists()
}

fn generate_backup_dir_name() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs();
    let days = total_secs / 86400;
    let mut y = 1970i64;
    let mut remaining_days = days as i64;
    loop {
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        let year_days: i64 = if leap { 366 } else { 365 };
        if remaining_days < year_days {
            break;
        }
        remaining_days -= year_days;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining_days < md as i64 {
            m = i;
            break;
        }
        remaining_days -= md as i64;
    }
    let day = remaining_days + 1;
    let time_of_day = total_secs % 86400;
    let hour = (time_of_day / 3600) + 8; // UTC+8
    let minute = (time_of_day % 3600) / 60;
    format!(
        "{}{:04}{:02}{:02}{:02}{:02}",
        BACKUP_DIR_PREFIX,
        y,
        m + 1,
        day,
        hour % 24,
        minute
    )
}

fn find_backup_directories(game_directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut backups: Vec<PathBuf> = fs::read_dir(game_directory)
        .map_err(|error| {
            format!(
                "读取目录失败：{}（{}）",
                path_to_string(game_directory),
                error
            )
        })?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            entry.path().is_dir() && name_str.starts_with(BACKUP_DIR_PREFIX)
        })
        .map(|entry| entry.path())
        .collect();

    backups.sort();
    Ok(backups)
}

fn has_backup_directory(game_directory: &Path) -> Result<bool, String> {
    Ok(!find_backup_directories(game_directory)?.is_empty())
}

fn find_latest_backup(game_directory: &Path) -> Result<PathBuf, String> {
    let mut backups = find_backup_directories(game_directory)?;
    backups
        .pop()
        .ok_or_else(|| "没有找到任何备份目录。".to_string())
}

#[tauri::command]
pub fn detect_game_directory() -> Option<String> {
    for drive in 'A'..='Z' {
        let root = PathBuf::from(format!("{drive}:/"));
        if !root.exists() {
            continue;
        }

        for common_path in COMMON_STEAM_PATHS {
            let candidate = root.join(common_path).join(GAME_FOLDER_NAME);
            if is_valid_game_directory(&candidate) {
                return Some(path_to_string(&candidate));
            }
        }
    }

    None
}

#[tauri::command]
pub fn has_backup(game_directory: String) -> Result<bool, String> {
    let game_directory = ensure_game_directory(&game_directory)?;
    has_backup_directory(&game_directory)
}

#[tauri::command]
pub async fn backup_mods(game_directory: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game_directory = ensure_game_directory(&game_directory)?;
        let backup_name = generate_backup_dir_name();
        let backup_directory = game_directory.join(&backup_name);
        let mods_directory = game_directory.join(MODS_DIR_NAME);

        fs::create_dir_all(&backup_directory).map_err(|error| {
            format!("创建目录失败：{}（{}）", path_to_string(&backup_directory), error)
        })?;

        if mods_directory.exists() {
            fs::rename(&mods_directory, backup_directory.join(MODS_DIR_NAME)).map_err(|error| {
                format!(
                    "移动目录失败：{} -> {}（{}）",
                    path_to_string(&mods_directory),
                    path_to_string(&backup_directory.join(MODS_DIR_NAME)),
                    error
                )
            })?;
        }

        let zip_files: Vec<_> = fs::read_dir(&game_directory)
            .map_err(|error| {
                format!("读取目录失败：{}（{}）", path_to_string(&game_directory), error)
            })?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("zip"))
                    .unwrap_or(false)
            })
            .collect();

        for entry in zip_files {
            let path = entry.path();
            let target_path = backup_directory.join(entry.file_name());
            fs::rename(&path, &target_path).map_err(|error| {
                format!(
                    "移动文件失败：{} -> {}（{}）",
                    path_to_string(&path),
                    path_to_string(&target_path),
                    error
                )
            })?;
        }

        Ok(format!("已备份到：{}", backup_name))
    })
    .await
    .map_err(|e| format!("任务执行失败：{}", e))?
}

#[tauri::command]
pub async fn resolve_download_url(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = url.trim().to_string();
        if trimmed.is_empty() {
            return Err("同步地址不能为空。".to_string());
        }

        match parse_repository_url(&trimmed) {
            Ok((owner, repo)) => {
                let asset = get_latest_release_asset_by_owner(&owner, &repo)?;
                Ok(asset.browser_download_url)
            }
            Err(_) => Ok(trimmed),
        }
    })
    .await
    .map_err(|e| format!("任务执行失败：{}", e))?
}

#[tauri::command]
pub async fn download_mods(
    app: tauri::AppHandle,
    game_directory: String,
    download_url: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game_directory = ensure_game_directory(&game_directory)?;
        if !has_backup_directory(&game_directory)? {
            return Err("请先备份当前 mods 后再同步。".to_string());
        }
        let archive_path = game_directory.join(DOWNLOAD_ARCHIVE_NAME);

        let _ = app.emit("download-progress", DownloadProgress {
            downloaded: 0,
            total: 0,
            phase: "downloading".to_string(),
        });

        download_asset(&download_url, &archive_path, &|downloaded, total| {
            let _ = app.emit("download-progress", DownloadProgress {
                downloaded,
                total,
                phase: "downloading".to_string(),
            });
        })?;

        let _ = app.emit("download-progress", DownloadProgress {
            downloaded: 0,
            total: 0,
            phase: "done".to_string(),
        });

        Ok(path_to_string(&archive_path))
    })
    .await
    .map_err(|e| format!("任务执行失败：{}", e))?
}

#[tauri::command]
pub async fn extract_mods(game_directory: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game_directory = ensure_game_directory(&game_directory)?;
        let archive_path = game_directory.join(DOWNLOAD_ARCHIVE_NAME);
        if !archive_path.exists() {
            return Err("未找到 mods.zip，请先下载。".to_string());
        }
        let mods_directory = extract_archive_to_mods(&archive_path, &game_directory)?;
        Ok(path_to_string(&mods_directory))
    })
    .await
    .map_err(|e| format!("任务执行失败：{}", e))?
}

#[tauri::command]
pub async fn restore_mods(game_directory: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game_directory = ensure_game_directory(&game_directory)?;
        let backup_directory = find_latest_backup(&game_directory)?;
        let mods_directory = game_directory.join(MODS_DIR_NAME);
        let backup_name = backup_directory
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        remove_path_if_exists(&mods_directory)?;

        let items: Vec<PathBuf> = fs::read_dir(&backup_directory)
            .map_err(|error| format!("读取目录失败：{}（{}）", path_to_string(&backup_directory), error))?
            .map(|entry| {
                entry
                    .map(|item| item.path())
                    .map_err(|error| {
                        format!(
                            "读取目录项失败：{}（{}）",
                            path_to_string(&backup_directory),
                            error
                        )
                    })
            })
            .collect::<Result<_, _>>()?;

        for item in items {
            let file_name = item
                .file_name()
                .ok_or_else(|| "备份目录中存在无效文件名。".to_string())?;
            let target_path = game_directory.join(file_name);

            remove_path_if_exists(&target_path)?;
            fs::rename(&item, &target_path).map_err(|error| {
                format!(
                    "移动文件失败：{} -> {}（{}）",
                    path_to_string(&item),
                    path_to_string(&target_path),
                    error
                )
            })?;
        }

        let is_empty = fs::read_dir(&backup_directory)
            .map_err(|error| format!("读取目录失败：{}（{}）", path_to_string(&backup_directory), error))?
            .next()
            .is_none();
        if is_empty {
            fs::remove_dir(&backup_directory).map_err(|error| {
                format!("删除目录失败：{}（{}）", path_to_string(&backup_directory), error)
            })?;
        }

        Ok(format!("已从 {} 还原。", backup_name))
    })
    .await
    .map_err(|e| format!("任务执行失败：{}", e))?
}

#[tauri::command]
pub fn open_directory(path: String) -> Result<(), String> {
    let directory = PathBuf::from(&path);
    if !directory.exists() {
        return Err("目录不存在。".to_string());
    }
    if !directory.is_dir() {
        return Err("指定路径不是目录。".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(&path);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&path);
        command
    };

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&path);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("打开目录失败：{}", error))?;

    Ok(())
}

#[tauri::command]
pub async fn list_backups(game_directory: String) -> Result<Vec<BackupInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game_directory = ensure_game_directory(&game_directory)?;
        let backups = find_backup_directories(&game_directory)?;
        Ok(backups
            .into_iter()
            .map(|path| {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let size_bytes = dir_size(&path);
                BackupInfo { name, size_bytes }
            })
            .collect())
    })
    .await
    .map_err(|e| format!("任务执行失败：{}", e))?
}

#[tauri::command]
pub async fn delete_backup(game_directory: String, backup_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game_directory = ensure_game_directory(&game_directory)?;
        let backup_name = backup_name.trim();
        if !backup_name.starts_with(BACKUP_DIR_PREFIX) {
            return Err("无效的备份目录名称。".to_string());
        }
        let backup_path = game_directory.join(backup_name);
        if !backup_path.exists() || !backup_path.is_dir() {
            return Err("备份目录不存在。".to_string());
        }
        remove_path_if_exists(&backup_path)
    })
    .await
    .map_err(|e| format!("任务执行失败：{}", e))?
}

#[tauri::command]
pub fn cleanup_stale_temp(game_directory: String) -> Result<(), String> {
    let game_directory = ensure_game_directory(&game_directory)?;
    let stale_dirs = ["mods.__extract__", "mods.__incoming__", "mods.__previous__"];
    for name in stale_dirs {
        let path = game_directory.join(name);
        remove_path_if_exists(&path)?;
    }
    Ok(())
}
