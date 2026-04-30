mod commands;

use commands::{
    add_common_mod, backup_mods, cleanup_stale_temp, delete_backup, delete_common_mod,
    detect_game_directory, download_mods, extract_mods, has_backup, has_mods_directory,
    list_backups, list_common_mods, open_common_mods_directory, open_directory,
    resolve_download_url, restore_mods, sync_mods,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    use window_vibrancy::apply_mica;
                    let _ = apply_mica(&window, None);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_game_directory,
            has_backup,
            has_mods_directory,
            backup_mods,
            download_mods,
            extract_mods,
            resolve_download_url,
            sync_mods,
            restore_mods,
            open_directory,
            list_backups,
            list_common_mods,
            add_common_mod,
            delete_common_mod,
            open_common_mods_directory,
            delete_backup,
            cleanup_stale_temp,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
