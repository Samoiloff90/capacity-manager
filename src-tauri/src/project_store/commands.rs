//! Production IPC and desktop policy shared with the MockRuntime integration test.
use super::{FolderPurpose, FormatUpgrade, ProjectSession, ProjectStore};
use std::path::PathBuf;
use tauri::{App, Runtime, State, Webview, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_sql::DbInstances;

/// The window may open or create a project only in the folder the user has just chosen in
/// the system dialog (Q-001): a path written by a script is refused.
const NOT_CHOSEN: &str = "Папку проекта нужно выбрать в окне выбора папки.";

/// Both the webview and its host window must be the configured main window.
fn is_main(view_label: &str, window_label: &str) -> bool {
    view_label == "main" && window_label == "main"
}

/// Shared by project lifecycle and report export commands, behind the ACL.
pub(crate) fn require_main<R: Runtime>(view: &Webview<R>) -> Result<(), String> {
    if is_main(view.label(), view.window().label()) {
        Ok(())
    } else {
        Err("Команда доступна только в главном окне.".into())
    }
}

/// Shows the system folder dialog on the native side and remembers the choice for one
/// open or create; None when the user cancels.
#[tauri::command]
pub async fn project_pick_folder<R: Runtime>(
    view: Webview<R>,
    store: State<'_, ProjectStore>,
    purpose: FolderPurpose,
) -> Result<Option<String>, String> {
    require_main(&view)?;
    store.forget_choice();
    let window = view.window();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(purpose.dialog_title())
        .pick_folder(move |folder| {
            let _ = sender.send(folder);
        });
    let folder = match receiver.await {
        Ok(Some(folder)) => folder
            .into_path()
            .map_err(|_| "Не удалось определить выбранную папку.".to_string())?,
        Ok(None) => return Ok(None),
        Err(_) => return Err("Окно выбора папки недоступно.".into()),
    };
    let folder = folder.to_string_lossy().into_owned();
    store.remember_choice(purpose, &folder);
    Ok(Some(folder))
}

#[tauri::command]
pub async fn project_create<R: Runtime>(
    view: Webview<R>,
    store: State<'_, ProjectStore>,
    instances: State<'_, DbInstances>,
    folder_path: String,
    name: String,
) -> Result<ProjectSession, String> {
    require_main(&view)?;
    if !store.take_choice(FolderPurpose::Create, &folder_path) {
        return Err(NOT_CHOSEN.into());
    }
    store
        .create(&instances, PathBuf::from(folder_path), name)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn project_open<R: Runtime>(
    view: Webview<R>,
    store: State<'_, ProjectStore>,
    instances: State<'_, DbInstances>,
    folder_path: String,
) -> Result<ProjectSession, String> {
    require_main(&view)?;
    if !store.take_choice(FolderPurpose::Open, &folder_path) {
        return Err(NOT_CHOSEN.into());
    }
    store
        .open(&instances, PathBuf::from(folder_path))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn project_close<R: Runtime>(
    view: Webview<R>,
    store: State<'_, ProjectStore>,
    instances: State<'_, DbInstances>,
    session_key: String,
) -> Result<(), String> {
    require_main(&view)?;
    store
        .close(&instances, &session_key)
        .await
        .map_err(|error| error.to_string())
}

/// Upgrades an open project of format 1 before its first save (DEC-044): a checked
/// backup in the project folder, then one transaction. Errors leave the file unchanged.
#[tauri::command]
pub async fn project_upgrade_format<R: Runtime>(
    view: Webview<R>,
    store: State<'_, ProjectStore>,
    session_key: String,
) -> Result<FormatUpgrade, String> {
    require_main(&view)?;
    store
        .upgrade_format(&session_key)
        .await
        .map_err(|error| error.to_string())
}

/// Composition root for all application IPC commands: one application-owned
/// store, the report export guard, no implicit database creation or legacy preload.
/// Every command listed here must also be declared in `build.rs` and allowed in
/// `capabilities/default.json`.
pub fn configure<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(ProjectStore::new())
        .manage(crate::report_export::ReportExportGuard::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            project_pick_folder,
            project_create,
            project_open,
            project_close,
            project_upgrade_format,
            crate::report_export::report_save_xlsx
        ])
}

/// Exact local origins only. Production never admits a development server.
pub fn navigation_allowed(url: &tauri::Url, development: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let local_assets = url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("tauri", Some("localhost")) | ("http", Some("tauri.localhost"))
        );
    let vite = development
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    local_assets || vite
}

/// Configured windows have create=false so no unguarded webview exists first.
pub fn build_main_window<R: Runtime>(
    app: &App<R>,
) -> Result<WebviewWindow<R>, Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or("Не найдены настройки главного окна")?;
    let window = tauri::WebviewWindowBuilder::from_config(app, config)?
        .on_navigation(|url| navigation_allowed(url, tauri::is_dev()))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_require_the_main_webview_in_the_main_window() {
        assert!(is_main("main", "main"));
        for (view, window) in [("main", "other"), ("other", "main"), ("other", "other")] {
            assert!(!is_main(view, window), "{view}/{window}");
        }
        let app = configure(tauri::test::mock_builder())
            .build(tauri::generate_context!(
                "tests/fixtures/storage/tauri.conf.json",
                test = true
            ))
            .unwrap();
        let main = build_main_window(&app).unwrap();
        assert_eq!(require_main(main.as_ref()), Ok(()));
        let other =
            tauri::WebviewWindowBuilder::new(&app, "untrusted-test-window", Default::default())
                .build()
                .unwrap();
        assert_eq!(
            require_main(other.as_ref()),
            Err("Команда доступна только в главном окне.".to_string())
        );
    }
}
