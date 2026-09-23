//! Production IPC and desktop policy shared with the MockRuntime integration test.
use super::{ProjectSession, ProjectStore};
use std::path::PathBuf;
use tauri::{App, Runtime, State, Webview, WebviewWindow};
use tauri_plugin_sql::DbInstances;

fn require_main<R: Runtime>(view: &Webview<R>) -> Result<(), String> {
    if view.label() == "main" && view.window().label() == "main" {
        Ok(())
    } else {
        Err("Команда проекта доступна только в главном окне".into())
    }
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

/// One application-owned store, no implicit database creation or legacy preload.
pub fn configure<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(ProjectStore::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            project_create,
            project_open,
            project_close
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
