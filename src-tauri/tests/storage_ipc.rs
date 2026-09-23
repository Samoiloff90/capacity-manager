//! Uses Tauri's mock window runtime, but real IPC dispatch/ACL, SQL plugin and SQLite.
//! This does not claim native WebView or portable-release validation.
use capacity_planner::project_store::commands;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{ipc::InvokeBody, test::MockRuntime, Manager};
use tauri_plugin_sql::DbInstances;

struct TempProject(PathBuf);
impl TempProject {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("capacity-ipc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempProject {
    fn drop(&mut self) {
        let target = self.0.canonicalize().expect("temporary test directory");
        let parent = std::env::temp_dir().canonicalize().unwrap();
        assert_eq!(target.parent(), Some(parent.as_path()));
        assert!(target
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("capacity-ipc-"));
        std::fs::remove_dir_all(target).expect("close all SQLite handles before cleanup");
    }
}

fn request(
    view: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    request_from(
        view,
        if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        },
        command,
        body,
    )
}

fn request_from(
    view: &tauri::WebviewWindow<MockRuntime>,
    origin: &str,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: origin.parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}

#[test]
fn native_session_and_real_plugin_ipc_preserve_snapshots_and_enforce_lifecycle_acl() {
    let temp = TempProject::new();
    let folder = temp.0.join("Команда А % # пробел");
    std::fs::create_dir(&folder).unwrap();
    let app = commands::configure(tauri::test::mock_builder())
        .build(tauri::generate_context!(
            "tests/fixtures/storage/tauri.conf.json"
        ))
        .expect("build isolated context without legacy preload");
    let view = commands::build_main_window(&app).unwrap();
    assert!(tauri::async_runtime::block_on(app.state::<DbInstances>().0.read()).is_empty());

    // Remote origins get neither SQL nor custom project lifecycle commands.
    for (command, body) in [
        (
            "project_create",
            json!({"folderPath":folder,"name":"Недопустимый запрос"}),
        ),
        (
            "plugin:sql|select",
            json!({"db":"missing","query":"SELECT 1","values":[]}),
        ),
    ] {
        let error = request_from(&view, "https://example.invalid", command, body).unwrap_err();
        assert!(error.to_string().contains("not allowed"), "{error}");
    }
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);
    for command in [
        "plugin:webview|create_webview_window",
        "plugin:window|create",
        "plugin:fs|read_text_file",
        "plugin:dialog|message",
        "plugin:dialog|save",
    ] {
        let error = request(&view, command, json!({})).unwrap_err();
        assert!(
            error.to_string().contains("not allowed"),
            "{command}: {error}"
        );
    }
    let other_view =
        tauri::WebviewWindowBuilder::new(&app, "untrusted-test-window", Default::default())
            .build()
            .unwrap();
    let error = request(
        &other_view,
        "project_create",
        json!({"folderPath":folder,"name":"Другое окно"}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("главном окне"), "{error}");
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);

    let forbidden = temp.0.join("must-not-be-created.sqlite");
    let error = request(
        &view,
        "plugin:sql|load",
        json!({"db": format!("sqlite:{}", forbidden.display())}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("not allowed"), "{error}");
    assert!(!forbidden.exists());

    let session = request(
        &view,
        "project_create",
        json!({"folderPath": folder, "name": "Команда А"}),
    )
    .unwrap();
    let key = session["sessionKey"].as_str().unwrap().to_owned();
    let payload = json!({"year":2026,"quarter":2,"calendar":[],"competencies":[],"members":[],"absences":[],"directions":[],"tasks":[]}).to_string();
    let inserted = request(&view, "plugin:sql|execute", json!({
        "db": key, "query": "INSERT INTO quarter_plans (plan_id,year,quarter,revision,payload_version,payload_json) VALUES ($1,2026,2,1,1,$2)",
        "values": ["quarter-a", payload]
    })).unwrap();
    assert_eq!(inserted[0], 1);
    let changed_payload = json!({"year":2026,"quarter":2,"calendar":[],"competencies":[],"members":[],"absences":[],"directions":[{"id":"calls","name":"Встречи","percent":"100"}],"tasks":[]}).to_string();
    // Keep the exact statement/parameters used by src/db/project-snapshots.ts.
    let save_query = "UPDATE quarter_plans SET payload_json = $1, revision = revision + 1 WHERE plan_id = $2 AND revision = $3 AND year = $4 AND quarter = $5 AND payload_version = $6";
    for metadata in [(2025, 2, 1), (2026, 3, 1), (2026, 2, 2)] {
        let wrong_metadata = json!({"db":key,"query":save_query,"values":[changed_payload,"quarter-a",1,metadata.0,metadata.1,metadata.2]});
        assert_eq!(
            request(&view, "plugin:sql|execute", wrong_metadata).unwrap()[0],
            0
        );
    }
    let unchanged = request(
        &view,
        "plugin:sql|select",
        json!({"db":key,"query":"SELECT revision,payload_json FROM quarter_plans","values":[]}),
    )
    .unwrap();
    assert_eq!(unchanged[0]["revision"], 1);
    assert_eq!(unchanged[0]["payload_json"], payload);
    let save =
        json!({"db":key,"query":save_query,"values":[changed_payload,"quarter-a",1,2026,2,1]});
    assert_eq!(
        request(&view, "plugin:sql|execute", save.clone()).unwrap()[0],
        1
    );
    assert_eq!(
        request(&view, "plugin:sql|execute", save).unwrap()[0],
        0,
        "stale CAS must not replace the newer snapshot"
    );
    let rows = request(&view, "plugin:sql|select", json!({"db":key,"query":"SELECT revision,payload_json FROM quarter_plans WHERE plan_id=$1","values":["quarter-a"]})).unwrap();
    assert_eq!(rows[0]["revision"], 2);
    assert_eq!(rows[0]["payload_json"], changed_payload);

    let denied_close = request(&view, "plugin:sql|close", json!({"db":key})).unwrap_err();
    assert!(
        denied_close.to_string().contains("not allowed"),
        "{denied_close}"
    );
    request(&view, "project_close", json!({"sessionKey":key})).unwrap();
    assert!(request(
        &view,
        "plugin:sql|select",
        json!({"db":key,"query":"SELECT 1","values":[]})
    )
    .is_err());
    let reopened = request(&view, "project_open", json!({"folderPath":folder})).unwrap();
    assert_ne!(reopened["sessionKey"], key);
    assert!(request(
        &view,
        "plugin:sql|select",
        json!({"db":key,"query":"SELECT 1","values":[]})
    )
    .is_err());
    let rows = request(&view, "plugin:sql|select", json!({"db":reopened["sessionKey"],"query":"SELECT revision,payload_json FROM quarter_plans","values":[]})).unwrap();
    assert_eq!(rows[0]["revision"], 2);
    assert_eq!(rows[0]["payload_json"], changed_payload);
    request(
        &view,
        "project_close",
        json!({"sessionKey":reopened["sessionKey"]}),
    )
    .unwrap();
    assert!(tauri::async_runtime::block_on(app.state::<DbInstances>().0.read()).is_empty());
}
