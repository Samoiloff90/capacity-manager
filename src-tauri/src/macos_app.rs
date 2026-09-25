//! macOS application menu and quit protection.
//!
//! Tauri's default macOS menu is in English, and its Quit item, the Dock's Quit and a
//! logout call `NSApp terminate:`, which in tao goes straight to `RunEvent::Exit`: the
//! unsaved-changes dialog on window close is skipped and the draft is lost silently.
//! Here every way to quit is turned into a close of the main window, the guarded path.
//!
//! Texts and decisions are platform-independent and tested on every OS. The AppKit glue
//! compiles only on macOS and is attached in `main.rs`, never in
//! `project_store::commands::configure`: muda builds menus only on the main thread, and
//! tests call `configure` from test threads.

pub const APP_NAME: &str = "Capacity Planner";
/// Menu id of the custom Quit item (Cmd+Q).
pub const QUIT_ID: &str = "quit";

/// Russian menu texts; the macOS application menu is titled by the bundle name.
pub mod text {
    pub const ABOUT: &str = "О программе Capacity Planner";
    pub const SERVICES: &str = "Службы";
    pub const HIDE: &str = "Скрыть Capacity Planner";
    pub const HIDE_OTHERS: &str = "Скрыть остальные";
    pub const SHOW_ALL: &str = "Показать все";
    pub const QUIT: &str = "Завершить Capacity Planner";
    pub const EDIT: &str = "Правка";
    pub const UNDO: &str = "Отменить";
    pub const REDO: &str = "Повторить";
    pub const CUT: &str = "Вырезать";
    pub const COPY: &str = "Скопировать";
    pub const PASTE: &str = "Вставить";
    pub const SELECT_ALL: &str = "Выбрать все";
    pub const WINDOW: &str = "Окно";
    pub const MINIMIZE: &str = "Свернуть";
    pub const CLOSE_WINDOW: &str = "Закрыть окно";

    pub const ALL: [&str; 16] = [
        ABOUT,
        SERVICES,
        HIDE,
        HIDE_OTHERS,
        SHOW_ALL,
        QUIT,
        EDIT,
        UNDO,
        REDO,
        CUT,
        COPY,
        PASTE,
        SELECT_ALL,
        WINDOW,
        MINIMIZE,
        CLOSE_WINDOW,
    ];
}

/// AppKit `NSApplicationTerminateReply` (an `NSUInteger`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum TerminateReply {
    Cancel = 0,
    Now = 1,
}

/// With a main window the quit is cancelled and the window is asked to close instead:
/// that close shows the unsaved-changes dialog and then exits the app by itself.
pub fn terminate_reply(has_main_window: bool) -> TerminateReply {
    if has_main_window {
        TerminateReply::Cancel
    } else {
        TerminateReply::Now
    }
}

pub fn is_quit_item(id: &str) -> bool {
    id == QUIT_ID
}

#[cfg(target_os = "macos")]
pub use platform::{app_menu, install_quit_hook, on_menu_event};

#[cfg(target_os = "macos")]
mod platform {
    use super::{is_quit_item, terminate_reply, text, TerminateReply, APP_NAME, QUIT_ID};
    use objc2::{
        class, ffi, msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject, Imp, Sel},
        sel, MainThreadMarker,
    };
    use std::{
        io::Write,
        panic::{catch_unwind, AssertUnwindSafe},
        sync::OnceLock,
    };
    use tauri::{
        menu::{
            AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
            WINDOW_SUBMENU_ID,
        },
        AppHandle, Manager, Runtime, WebviewWindow, Wry,
    };

    const MAIN_WINDOW: &str = "main";
    /// tao's NSApplication delegate class; the hook is added only to this known class.
    const TAO_DELEGATE_CLASS: &std::ffi::CStr = c"TaoAppDelegateParent";

    static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();

    /// Never panics: `eprintln!` would panic on a closed stderr inside an `extern "C"` hook.
    fn log(message: &str) {
        let _ = writeln!(std::io::stderr(), "capacity-planner: {message}");
    }

    pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
        let about = AboutMetadata {
            name: Some(APP_NAME.into()),
            version: Some(app.package_info().version.to_string()),
            ..Default::default()
        };
        let application = Submenu::with_items(
            app,
            APP_NAME,
            true,
            &[
                &PredefinedMenuItem::about(app, Some(text::ABOUT), Some(about))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, Some(text::SERVICES))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some(text::HIDE))?,
                &PredefinedMenuItem::hide_others(app, Some(text::HIDE_OTHERS))?,
                &PredefinedMenuItem::show_all(app, Some(text::SHOW_ALL))?,
                &PredefinedMenuItem::separator(app)?,
                // A plain item, not the predefined Quit: that one calls terminate:.
                &MenuItem::with_id(app, QUIT_ID, text::QUIT, true, Some("CmdOrCtrl+Q"))?,
            ],
        )?;
        // Predefined items keep the native selectors, so Cmd+C/V/X/A work in WKWebView.
        let edit = Submenu::with_items(
            app,
            text::EDIT,
            true,
            &[
                &PredefinedMenuItem::undo(app, Some(text::UNDO))?,
                &PredefinedMenuItem::redo(app, Some(text::REDO))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, Some(text::CUT))?,
                &PredefinedMenuItem::copy(app, Some(text::COPY))?,
                &PredefinedMenuItem::paste(app, Some(text::PASTE))?,
                &PredefinedMenuItem::select_all(app, Some(text::SELECT_ALL))?,
            ],
        )?;
        let window = Submenu::with_id_and_items(
            app,
            WINDOW_SUBMENU_ID,
            text::WINDOW,
            true,
            &[
                &PredefinedMenuItem::minimize(app, Some(text::MINIMIZE))?,
                &PredefinedMenuItem::separator(app)?,
                // performClose: -> CloseRequested -> the guarded close.
                &PredefinedMenuItem::close_window(app, Some(text::CLOSE_WINDOW))?,
            ],
        )?;
        Menu::with_items(app, &[&application, &edit, &window])
    }

    /// Brings the window forward so the unsaved-changes dialog is visible, then asks it to
    /// close. `close()` is always queued on the event loop, so the dialog runs later.
    fn request_guarded_close<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
        let _ = app.show();
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Err(error) = window.close() {
            log(&format!("could not request window close: {error}"));
        }
    }

    pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
        if !is_quit_item(event.id().as_ref()) {
            return;
        }
        match app.get_webview_window(MAIN_WINDOW) {
            Some(window) => request_guarded_close(app, &window),
            None => app.exit(0),
        }
    }

    /// Adds `applicationShouldTerminate:` to tao's app delegate, so Dock → Quit, logout and
    /// AppleScript `quit` take the guarded close too. Must run in `setup` (main thread,
    /// after tao has set its delegate). On failure only the Cmd+Q item stays guarded.
    pub fn install_quit_hook(app: &AppHandle<Wry>) {
        let _ = APP.set(app.clone());
        if MainThreadMarker::new().is_none() {
            log("quit hook not installed: not on the main thread");
            return;
        }
        // SAFETY: plain AppKit getters, called on the main thread.
        let delegate: Option<Retained<AnyObject>> = unsafe {
            let ns_app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
            msg_send![&*ns_app, delegate]
        };
        let Some(delegate) = delegate else {
            log("quit hook not installed: NSApp has no delegate");
            return;
        };
        let class: &'static AnyClass = delegate.class();
        if class.name() != TAO_DELEGATE_CLASS {
            log(&format!(
                "quit hook not installed: unexpected delegate class {:?}",
                class.name()
            ));
            return;
        }
        if class.responds_to(sel!(applicationShouldTerminate:)) {
            log(
                "quit hook not installed: the delegate already handles applicationShouldTerminate:",
            );
            return;
        }
        type Hook = extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;
        // SAFETY: `should_terminate` has the Objective-C signature `Q@:@` of
        // applicationShouldTerminate: (self, _cmd, sender) -> NSApplicationTerminateReply,
        // and the class is tao's registered delegate class, which lives for the process.
        let added = unsafe {
            let imp = std::mem::transmute::<Hook, Imp>(should_terminate as Hook);
            ffi::class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            )
        };
        if added.as_bool() {
            log("quit hook installed");
        } else {
            log("quit hook not installed: class_addMethod failed");
        }
    }

    /// `extern "C"`: a panic aborts instead of unwinding into AppKit; the body also catches it.
    extern "C" fn should_terminate(
        _this: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        let reply = catch_unwind(AssertUnwindSafe(|| {
            let Some(app) = APP.get() else {
                return TerminateReply::Now;
            };
            let window = app.get_webview_window(MAIN_WINDOW);
            let reply = terminate_reply(window.is_some());
            if let Some(window) = window {
                let (app, fallback) = (app.clone(), window.clone());
                // Off the main thread every call is queued and runs after terminate: returns.
                let spawned = std::thread::Builder::new()
                    .name("capacity-quit".into())
                    .spawn(move || request_guarded_close(&app, &window));
                if spawned.is_err() {
                    let _ = fallback.close();
                }
            }
            reply
        }))
        .unwrap_or(TerminateReply::Cancel);
        log(&format!("applicationShouldTerminate: {reply:?}"));
        reply as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_texts_are_russian_apart_from_the_app_name() {
        for item in text::ALL {
            let rest = item.replace(APP_NAME, "");
            assert!(!rest.trim().is_empty(), "{item}");
            assert!(
                rest.chars().all(|c| c == ' '
                    || ('а'..='я').contains(&c.to_lowercase().next().unwrap())
                    || c == 'ё'
                    || c == 'Ё'),
                "{item}"
            );
        }
    }

    #[test]
    fn only_the_quit_item_quits() {
        assert!(is_quit_item(QUIT_ID));
        assert!(!is_quit_item("close_window"));
        assert!(!is_quit_item(""));
    }

    #[test]
    fn quit_with_a_window_becomes_a_guarded_close() {
        assert_eq!(terminate_reply(true), TerminateReply::Cancel);
        assert_eq!(terminate_reply(false), TerminateReply::Now);
        assert_eq!(TerminateReply::Cancel as usize, 0);
        assert_eq!(TerminateReply::Now as usize, 1);
    }
}
