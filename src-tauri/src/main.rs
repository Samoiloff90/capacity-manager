#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
use capacity_planner::macos_app;
use capacity_planner::project_store::commands;

fn main() {
    let builder = commands::configure(tauri::Builder::default());
    // macOS only: a Russian app menu and quit through the guarded window close. On Windows
    // an app menu would add a menu bar to the window.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(macos_app::app_menu)
        .on_menu_event(macos_app::on_menu_event);
    builder
        .setup(|app| {
            commands::build_main_window(app)?;
            #[cfg(target_os = "macos")]
            macos_app::install_quit_hook(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
