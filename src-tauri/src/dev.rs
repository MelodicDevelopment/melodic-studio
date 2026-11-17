//! Development aids, inert in release builds.
//!
//! `STUDIO_DEV_EVAL=/path/to/file.js npm run desktop:dev` makes a debug build
//! run that file's JavaScript in the window every time the file changes, and
//! `dev_log` sends lines from the window back to this process's stderr (and to
//! `STUDIO_DEV_LOG` if set). Together they let a script exercise the real app,
//! real backend included, without touching the mouse or keyboard.

#[tauri::command]
pub fn dev_log(line: String) {
    #[cfg(debug_assertions)]
    {
        eprintln!("[studio] {line}");
        if let Ok(path) = std::env::var("STUDIO_DEV_LOG") {
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{line}");
            }
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = line;
}

pub fn start(app: &tauri::AppHandle) {
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("STUDIO_DEV_EVAL") {
        use tauri::Manager;
        let app = app.clone();
        std::thread::spawn(move || {
            let mut seen = None;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
                if modified.is_some() && modified != seen {
                    seen = modified;
                    if let (Ok(code), Some(window)) = (std::fs::read_to_string(&path), app.get_webview_window("main")) {
                        let _ = window.eval(&code);
                    }
                }
            }
        });
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
}
