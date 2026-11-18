//! The window's menu bar (the macOS app menu, and the menu bar Windows and Linux show in the window).
//! Our own items send their id to the page as a `menu` event; everything else is the platform's.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// Ids the page handles (`MenuService` in the frontend).
pub const NEW_PROJECT: &str = "new-project";
pub const ADD_REPO: &str = "add-repo";
pub const CLONE_REPO: &str = "clone-repo";
pub const SETTINGS: &str = "settings";
pub const CHECK_UPDATES: &str = "check-updates";

/// Shortcuts are only shown on macOS, where the menu bar takes them before the page sees the key.
/// Elsewhere the page catches the same keys itself (a focused WebView2 does not pass them to the menu).
fn key(accelerator: &'static str) -> Option<&'static str> {
    cfg!(target_os = "macos").then_some(accelerator)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let about = AboutMetadata { name: Some(info.name.clone()), version: Some(info.version.to_string()), copyright: app.config().bundle.copyright.clone(), ..Default::default() };
    let item = |id: &str, label: &str, accelerator: Option<&str>| MenuItem::with_id(app, id, label, true, accelerator);
    let sep = || PredefinedMenuItem::separator(app);

    let settings = item(SETTINGS, if cfg!(target_os = "macos") { "Settings…" } else { "Settings" }, key("CmdOrCtrl+,"))?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(NEW_PROJECT, "New Project…", key("CmdOrCtrl+Shift+N"))?,
            &item(ADD_REPO, "Add Existing Folder…", key("CmdOrCtrl+O"))?,
            &item(CLONE_REPO, "Clone Repository…", None)?,
            &sep()?,
            #[cfg(not(target_os = "macos"))]
            &settings,
            #[cfg(not(target_os = "macos"))]
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::fullscreen(app, None)?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item(CHECK_UPDATES, "Check for Updates…", None)?,
            #[cfg(not(target_os = "macos"))]
            &sep()?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, None, Some(about.clone()))?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            info.name.clone(),
            true,
            &[
                &PredefinedMenuItem::about(app, None, Some(about))?,
                &sep()?,
                &settings,
                &sep()?,
                &PredefinedMenuItem::services(app, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep()?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &window, &help])
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = about;
        Menu::with_items(app, &[&file, &edit, &window, &help])
    }
}

/// Our items reach the page as `menu` events carrying the item's id.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().0.as_str();
    if [NEW_PROJECT, ADD_REPO, CLONE_REPO, SETTINGS, CHECK_UPDATES].contains(&id) {
        let _ = app.emit("menu", id);
    }
}
