//! Recent repositories on the Dock icon (macOS): right-click the icon and they are listed above the usual items.
//!
//! The list is the system's own "recent documents" of the app, which macOS keeps per app (by its code
//! signature: an ad-hoc signed dev build starts again after each rebuild), so it is there while the app is
//! not running too and nothing of ours stores it. Picking an entry makes
//! macOS ask the app to open that folder (`RunEvent::Opened`), exactly as dropping a folder on the icon or
//! Finder's "Open With" does. Those folders wait in `Opened` until the page takes them (`opened_take`):
//! at a launch from the Dock the request arrives before the page listens.
//!
//! macOS only lists them for an app that declares it opens folders (`CFBundleDocumentTypes` in
//! `Info.plist`, and in the dev bundle of `scripts/dev-app.sh`). Elsewhere `note` and `forget` do nothing.

use crate::error::Result;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Runtime, State};

/// Folders the system asked the app to open that the page has not taken yet.
#[derive(Default)]
pub struct Opened(Mutex<Vec<String>>);

/// A repository was opened: it leads the Dock's list from now on.
pub fn note<R: Runtime>(app: &AppHandle<R>, path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let path = path.to_path_buf();
        let _ = app.run_on_main_thread(move || mac::note(&path));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, path);
}

/// A repository was removed from the app: it leaves the Dock's list, the others keep their order.
pub fn forget<R: Runtime>(app: &AppHandle<R>, path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let (path, later) = (path.to_path_buf(), app.clone());
        let _ = app.run_on_main_thread(move || {
            // There is no "remove one": the list is cleared and the rest noted again, oldest first. Noted
            // all at once, only the last one stayed, so each goes on its own turn of the main thread.
            let keep = mac::clear_except(&path);
            std::thread::spawn(move || {
                for path in keep {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    let _ = later.run_on_main_thread(move || mac::note(&path));
                }
            });
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, path);
}

/// macOS asks for these to be opened. Only folders are kept; the page is told there is something to take.
#[cfg(target_os = "macos")]
pub fn opened<R: Runtime>(app: &AppHandle<R>, urls: &[tauri::Url]) {
    use tauri::{Emitter, Manager};
    let folders = folders(urls);
    if folders.is_empty() {
        return;
    }
    app.state::<Opened>().0.lock().unwrap().extend(folders);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit("opened", ());
}

/// The folders among what the system handed over, as paths (without the `/` a folder's URL ends with).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn folders(urls: &[tauri::Url]) -> Vec<String> {
    urls.iter().filter_map(|u| u.to_file_path().ok()).filter(|p| p.is_dir()).map(|p| p.components().collect::<std::path::PathBuf>().to_string_lossy().into_owned()).collect()
}

/// The folders waiting to be opened, each handed over once.
#[tauri::command]
pub async fn opened_take(state: State<'_, Opened>) -> Result<Vec<String>> {
    Ok(std::mem::take(&mut *state.0.lock().unwrap()))
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSDocumentController;
    use objc2_foundation::NSURL;
    use std::path::{Path, PathBuf};

    pub fn note(path: &Path) {
        let (Some(mtm), Some(url)) = (MainThreadMarker::new(), NSURL::from_directory_path(path)) else {
            return;
        };
        NSDocumentController::sharedDocumentController(mtm).noteNewRecentDocumentURL(&url);
    }

    /// Clears the list when `path` is on it, and answers the others, oldest first, to be noted again.
    pub fn clear_except(path: &Path) -> Vec<PathBuf> {
        let Some(mtm) = MainThreadMarker::new() else {
            return Vec::new();
        };
        let recent = NSDocumentController::sharedDocumentController(mtm);
        let all: Vec<PathBuf> = recent.recentDocumentURLs().to_vec().iter().filter_map(|u| u.to_file_path()).collect();
        if !all.iter().any(|p| crate::paths::same(p, path)) {
            return Vec::new();
        }
        // SAFETY: the sender is only passed along to the action, and none is a valid sender.
        unsafe { recent.clearRecentDocuments(None) };
        all.into_iter().rev().filter(|p| !crate::paths::same(p, path)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_folders_are_opened() {
        let dir = std::env::temp_dir().join(format!("studio-recent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        let urls = [
            tauri::Url::from_directory_path(&dir).unwrap(),
            tauri::Url::from_file_path(&file).unwrap(),
            tauri::Url::from_file_path(dir.join("gone")).unwrap(),
            tauri::Url::parse("https://example.com/").unwrap(),
        ];
        let found = folders(&urls);
        assert_eq!(found.len(), 1);
        assert!(crate::paths::same(&found[0], &dir));
        assert!(!found[0].ends_with(std::path::MAIN_SEPARATOR));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
