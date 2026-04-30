mod commands;

use commands::{
    backup_mods, detect_game_directory, has_backup, open_directory, resolve_download_url,
    restore_mods, sync_mods,
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
            backup_mods,
            sync_mods,
            resolve_download_url,
            restore_mods,
            open_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
