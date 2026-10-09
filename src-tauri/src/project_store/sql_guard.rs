//! What the main window may do with the open project through the SQL plugin (Q-001).
//!
//! The plugin runs any SQL text the window sends on the project's only connection. This
//! guard narrows it in the trusted layer, whatever the JavaScript side does:
//! - no other database can be attached: `ATTACH` fails, and so do `VACUUM` and
//!   `VACUUM INTO`, which attach their target the same way;
//! - the authorizer admits only what the application itself issues
//!   (`src/db/project-snapshots.ts`): reading the project, adding a quarter, saving a
//!   quarter with its revision and renaming the project. Schema changes, `PRAGMA`,
//!   `DELETE`, transactions and reading SQLite's own tables are refused. A transaction
//!   left open by the window would hold the store's own work, such as a format upgrade.
//!
//! The store's own work on that connection (validating a project, upgrading its format)
//! runs in a trusted scope that only Rust can open, while it holds the connection.
//! Statements prepared there are dropped from the connection's statement cache before
//! the window can use the connection again: SQLite checks a statement when it is
//! prepared, so a cached one must never be reused by the window.
use libsqlite3_sys as ffi;
use sqlx::{pool::PoolConnection, Connection, Sqlite, SqliteConnection};
use std::{
    ffi::{c_char, c_int, c_void, CStr},
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) struct SqlGuard {
    trusted: AtomicBool,
}

impl SqlGuard {
    /// One per project pool. SQLite keeps a raw pointer to it in every connection of the
    /// pool, which may outlive the session, so it lives as long as the process.
    pub(super) fn leaked() -> &'static SqlGuard {
        Box::leak(Box::new(SqlGuard {
            trusted: AtomicBool::new(false),
        }))
    }

    /// Called at the end of `after_connect`, after the store's own setup statements.
    pub(super) async fn install(
        &'static self,
        connection: &mut SqliteConnection,
    ) -> sqlx::Result<()> {
        // The setup PRAGMAs were prepared without the authorizer: none may be reused.
        connection.clear_cached_statements().await?;
        let mut handle = connection.lock_handle().await?;
        let raw = handle.as_raw_handle().as_ptr();
        // SAFETY: the locked handle gives exclusive access to an open connection, and the
        // guard is 'static, so the pointer stays valid for every later callback.
        let status = unsafe {
            ffi::sqlite3_limit(raw, ffi::SQLITE_LIMIT_ATTACHED, 0);
            ffi::sqlite3_set_authorizer(
                raw,
                Some(authorize),
                self as *const SqlGuard as *mut c_void,
            )
        };
        if status == ffi::SQLITE_OK {
            Ok(())
        } else {
            Err(sqlx::Error::Protocol(
                "SQLite authorizer was not installed".into(),
            ))
        }
    }

    /// Full SQL for the store's own statements on the acquired connection of this pool.
    /// The pool has one connection, so the window cannot run anything meanwhile.
    pub(super) fn trust(&'static self, connection: PoolConnection<Sqlite>) -> Trusted {
        self.trusted.store(true, Ordering::SeqCst);
        Trusted {
            guard: self,
            connection: Some(connection),
        }
    }
}

/// A trusted scope. `finish` drops the statements it prepared and returns the connection
/// to the window's rules; if it is dropped without `finish` (a panic, a cancelled task),
/// the connection is closed instead of going back to the pool with them.
pub(super) struct Trusted {
    guard: &'static SqlGuard,
    connection: Option<PoolConnection<Sqlite>>,
}

impl Trusted {
    pub(super) fn connection(&mut self) -> &mut SqliteConnection {
        self.connection.as_mut().expect("trusted connection")
    }

    pub(super) async fn finish(mut self) -> sqlx::Result<()> {
        let mut connection = self.connection.take().expect("trusted connection");
        let cleared = connection.clear_cached_statements().await;
        if cleared.is_err() {
            connection.close_on_drop();
        }
        self.guard.trusted.store(false, Ordering::SeqCst);
        drop(connection);
        cleared
    }
}

impl Drop for Trusted {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            connection.close_on_drop();
        }
        self.guard.trusted.store(false, Ordering::SeqCst);
    }
}

extern "C" fn authorize(
    data: *mut c_void,
    action: c_int,
    first: *const c_char,
    second: *const c_char,
    database: *const c_char,
    _trigger: *const c_char,
) -> c_int {
    // SAFETY: `data` is the 'static guard given to sqlite3_set_authorizer; the strings
    // are NUL-terminated or null, as SQLite documents for the authorizer callback.
    let guard = unsafe { &*(data as *const SqlGuard) };
    if guard.trusted.load(Ordering::SeqCst) {
        return ffi::SQLITE_OK;
    }
    let text = |pointer: *const c_char| {
        (!pointer.is_null())
            .then(|| unsafe { CStr::from_ptr(pointer) }.to_str().ok())
            .flatten()
    };
    if admitted(action, text(first), text(second), text(database)) {
        ffi::SQLITE_OK
    } else {
        ffi::SQLITE_DENY
    }
}

/// The statements of `src/db/project-snapshots.ts`, and nothing else.
pub(super) fn admitted(
    action: c_int,
    first: Option<&str>,
    second: Option<&str>,
    database: Option<&str>,
) -> bool {
    let main = database == Some("main");
    match action {
        ffi::SQLITE_SELECT | ffi::SQLITE_RECURSIVE => true,
        ffi::SQLITE_FUNCTION => {
            second.is_some_and(|name| !name.eq_ignore_ascii_case("load_extension"))
        }
        ffi::SQLITE_READ => main && matches!(first, Some("quarter_plans" | "project_meta")),
        ffi::SQLITE_INSERT => main && first == Some("quarter_plans"),
        ffi::SQLITE_UPDATE => {
            main && matches!(
                (first, second),
                (
                    Some("quarter_plans"),
                    Some("payload_json" | "payload_version" | "revision")
                ) | (Some("project_meta"), Some("name"))
            )
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_only_the_statements_of_the_application() {
        let main = Some("main");
        for (action, first, second) in [
            (ffi::SQLITE_SELECT, None, None),
            (
                ffi::SQLITE_READ,
                Some("quarter_plans"),
                Some("payload_json"),
            ),
            (ffi::SQLITE_READ, Some("project_meta"), Some("project_id")),
            (ffi::SQLITE_INSERT, Some("quarter_plans"), None),
            (ffi::SQLITE_UPDATE, Some("quarter_plans"), Some("revision")),
            (ffi::SQLITE_UPDATE, Some("project_meta"), Some("name")),
            (ffi::SQLITE_FUNCTION, None, Some("sqlite_version")),
        ] {
            assert!(
                admitted(action, first, second, main),
                "{action} {first:?} {second:?}"
            );
        }
        for (action, first, second, database) in [
            (ffi::SQLITE_ATTACH, Some("/tmp/other.sqlite"), None, None),
            (ffi::SQLITE_DETACH, Some("other"), None, None),
            (ffi::SQLITE_PRAGMA, Some("user_version"), Some("1"), None),
            (ffi::SQLITE_PRAGMA, Some("writable_schema"), None, None),
            (ffi::SQLITE_CREATE_TABLE, Some("t"), None, main),
            (ffi::SQLITE_CREATE_TEMP_TABLE, Some("t"), None, Some("temp")),
            (ffi::SQLITE_DROP_TABLE, Some("quarter_plans"), None, main),
            (
                ffi::SQLITE_ALTER_TABLE,
                Some("main"),
                Some("quarter_plans"),
                None,
            ),
            (
                ffi::SQLITE_CREATE_TRIGGER,
                Some("t"),
                Some("quarter_plans"),
                main,
            ),
            (ffi::SQLITE_DELETE, Some("quarter_plans"), None, main),
            (ffi::SQLITE_READ, Some("sqlite_master"), Some("sql"), main),
            (
                ffi::SQLITE_READ,
                Some("quarter_plans"),
                Some("plan_id"),
                Some("other"),
            ),
            (ffi::SQLITE_INSERT, Some("project_meta"), None, main),
            (
                ffi::SQLITE_UPDATE,
                Some("project_meta"),
                Some("project_id"),
                main,
            ),
            (
                ffi::SQLITE_UPDATE,
                Some("quarter_plans"),
                Some("plan_id"),
                main,
            ),
            (ffi::SQLITE_FUNCTION, None, Some("load_extension"), None),
            (ffi::SQLITE_SAVEPOINT, Some("BEGIN"), Some("s"), None),
            (ffi::SQLITE_TRANSACTION, Some("BEGIN"), None, None),
            (ffi::SQLITE_TRANSACTION, Some("COMMIT"), None, None),
            (ffi::SQLITE_ANALYZE, None, None, main),
            (ffi::SQLITE_REINDEX, Some("quarter_plans_year"), None, main),
            (999, None, None, main),
        ] {
            assert!(
                !admitted(action, first, second, database),
                "{action} {first:?} {second:?}"
            );
        }
    }
}
