//! Configuration/policy regressions; real WebView behavior is a separate smoke test.
use capacity_planner::project_store::commands::navigation_allowed;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[test]
fn navigation_is_local_and_development_origin_is_explicit() {
    for url in [
        "tauri://localhost/",
        "tauri://localhost/index.html#/quarter",
        "http://tauri.localhost/",
    ] {
        assert!(navigation_allowed(&url.parse().unwrap(), false), "{url}");
    }
    for url in [
        "https://example.invalid/",
        "http://example.invalid/",
        "file:///C:/private.txt",
        "data:text/html,test",
        "javascript:alert(1)",
        "about:blank",
        "http://tauri.localhost.example.invalid/",
        "tauri://other/",
        "https://tauri.localhost/",
        "http://tauri.localhost:4444/",
        "tauri://localhost:1420/",
        "http://user@tauri.localhost/",
        "http://127.0.0.1:1420/",
        "http://localhost:1420/",
    ] {
        assert!(!navigation_allowed(&url.parse().unwrap(), false), "{url}");
    }
    assert!(navigation_allowed(
        &"http://127.0.0.1:1420/path".parse().unwrap(),
        true
    ));
    for url in [
        "http://127.0.0.1:1421/",
        "http://localhost:1420/",
        "https://127.0.0.1:1420/",
        "http://user@127.0.0.1:1420/",
        "https://example.invalid/",
    ] {
        assert!(!navigation_allowed(&url.parse().unwrap(), true), "{url}");
    }
}

fn directives(value: &str) -> BTreeMap<&str, Vec<&str>> {
    let mut directives = BTreeMap::new();
    for directive in value
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let mut words = directive.split_whitespace();
        assert!(directives
            .insert(words.next().unwrap(), words.collect())
            .is_none());
    }
    directives
}

#[test]
fn production_configuration_has_no_preload_remote_capability_or_broad_permissions() {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let capabilities: Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    assert_eq!(config["plugins"], json!({}));
    assert_eq!(config["build"]["devUrl"], "http://127.0.0.1:1420");
    assert_eq!(config["app"]["windows"].as_array().unwrap().len(), 1);
    assert_eq!(config["app"]["windows"][0]["label"], "main");
    assert_eq!(config["app"]["windows"][0]["create"], false);
    assert_eq!(
        config["app"]["security"]["capabilities"],
        json!(["default"])
    );
    assert_eq!(capabilities["windows"], json!(["main"]));
    assert!(capabilities.get("remote").is_none());
    let permissions: BTreeSet<_> = capabilities["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|permission| permission.as_str().unwrap())
        .collect();
    assert_eq!(
        permissions,
        BTreeSet::from([
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:window:allow-close",
            "core:window:allow-destroy",
            "dialog:allow-open",
            "sql:allow-execute",
            "sql:allow-select",
            "allow-project-create",
            "allow-project-open",
            "allow-project-close",
            "allow-report-save-xlsx",
        ])
    );
    // Reports are saved only through the narrow native command, never by the WebView.
    assert!(!permissions
        .iter()
        .any(|permission| permission.starts_with("fs:")));
    assert!(!permissions.contains("dialog:allow-save"));
    let production = directives(config["app"]["security"]["csp"].as_str().unwrap());
    let development = directives(config["app"]["security"]["devCsp"].as_str().unwrap());
    assert_eq!(production["connect-src"], ["ipc:", "http://ipc.localhost"]);
    assert_eq!(production["script-src"], ["'self'"]);
    assert_eq!(
        development["connect-src"],
        [
            "ipc:",
            "http://ipc.localhost",
            "http://127.0.0.1:1420",
            "ws://127.0.0.1:1420"
        ]
    );
    for policy in [&production, &development] {
        assert_eq!(policy["default-src"], ["'self'"]);
        for directive in [
            "object-src",
            "base-uri",
            "frame-src",
            "frame-ancestors",
            "form-action",
        ] {
            assert_eq!(policy[directive], ["'none'"]);
        }
        assert!(!policy
            .values()
            .flatten()
            .any(|source| *source == "*" || *source == "'unsafe-eval'"));
    }
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/storage/tauri.conf.json")).unwrap();
    assert_eq!(
        fixture["app"]["security"]["capabilities"],
        config["app"]["security"]["capabilities"]
    );
    assert_eq!(fixture["plugins"], json!({}));
}
