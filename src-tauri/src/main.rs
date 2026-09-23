#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use capacity_planner::project_store::commands;

fn main() {
    commands::configure(tauri::Builder::default())
        .setup(|app| {
            commands::build_main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
