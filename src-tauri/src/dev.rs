//! Development aids, inert in release builds.
//!
//! `STUDIO_DEV_EVAL=/path/to/file.js npm run desktop:dev` makes a debug build
//! run that file's JavaScript in the window every time the file changes, and
//! `dev_log` sends lines from the window back to this process's stderr (and to
//! `STUDIO_DEV_LOG` if set). Together they let a script exercise the real app,
//! real backend included, without touching the mouse or keyboard.
//!
//! `server` keeps a debug build from opening as a white window when nothing is
//! serving its pages (see there).

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
    #[cfg(dev)]
    server::ensure(app);
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

/// Called once, as the app exits.
pub fn stop(app: &tauri::AppHandle) {
    #[cfg(dev)]
    server::stop(app);
    #[cfg(not(dev))]
    let _ = app;
}

/// The dev server a build made without the bundled pages depends on (`cfg(dev)`: `tauri dev`, `cargo run`).
///
/// Such a build has no pages of its own: the window shows what Vite serves at `build.devUrl`.
/// `npm run desktop:dev` starts Vite first, but the same build opened any other way (its Dock icon,
/// Finder, `cargo run`) found nothing at that address and stayed a white window. So when the address
/// does not answer, the app starts Vite itself, says so in the window meanwhile, and stops it on exit.
/// If that fails the window says why, and still switches to the app once something answers.
#[cfg(dev)]
mod server {
    use crate::proc;
    use base64::Engine;
    use std::net::{SocketAddr, TcpStream};
    use std::path::Path;
    use std::process::{Child, Stdio};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::{Manager, Url};

    /// The Vite process this app started, if it had to.
    #[derive(Default)]
    pub struct DevServer(Mutex<Option<Child>>);

    pub fn ensure(app: &tauri::AppHandle) {
        app.manage(DevServer::default());
        let Some(url) = app.config().build.dev_url.clone() else { return };
        let addrs = url.socket_addrs(|| None).unwrap_or_default();
        if addrs.is_empty() || reachable(&addrs) {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            show(&app, page("Starting the dev server\u{2026}", ""));
            if let Err(why) = start(&app, &addrs) {
                show(&app, page("The dev server is not running", &failure(&url, &why)));
                while !reachable(&addrs) {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            show(&app, url);
        });
    }

    pub fn stop(app: &tauri::AppHandle) {
        let child = app.try_state::<DevServer>().and_then(|server| server.0.lock().unwrap().take());
        if let Some(mut child) = child {
            proc::kill_tree(&mut child);
            let _ = child.wait();
        }
    }

    /// The folder with package.json: this crate's parent, fixed when the build was made.
    fn project() -> &'static Path {
        let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        crate_dir.parent().unwrap_or(crate_dir)
    }

    /// Runs Vite and waits until it answers. `node vite.js` rather than `npm run dev`: one process
    /// that `kill_tree` really stops, where npm would leave Vite running behind it.
    fn start(app: &tauri::AppHandle, addrs: &[SocketAddr]) -> Result<(), String> {
        let vite = project().join("node_modules").join("vite").join("bin").join("vite.js");
        if !vite.is_file() {
            return Err(format!("{} is missing: run npm install first.", vite.display()));
        }
        let child = proc::command("node").arg(&vite).current_dir(project()).stdin(Stdio::null()).spawn().map_err(|e| format!("node could not be started: {e}"))?;
        let server = app.state::<DevServer>();
        *server.0.lock().unwrap() = Some(child);

        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if reachable(addrs) {
                return Ok(());
            }
            match server.0.lock().unwrap().as_mut().map(Child::try_wait) {
                Some(Ok(None)) => {}
                Some(Ok(Some(status))) => return Err(format!("Vite stopped by itself ({status}).")),
                Some(Err(e)) => return Err(format!("Vite could not be watched: {e}")),
                None => return Err("The window was closed.".into()),
            }
            if Instant::now() > deadline {
                return Err("Vite did not answer within 30 seconds.".into());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    fn reachable(addrs: &[SocketAddr]) -> bool {
        addrs.iter().any(|addr| TcpStream::connect_timeout(addr, Duration::from_millis(300)).is_ok())
    }

    fn show(app: &tauri::AppHandle, url: Url) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.navigate(url);
        }
    }

    fn failure(url: &Url, why: &str) -> String {
        format!(
            "This is a development build: its window shows what Vite serves at {url}, and nothing answers there.\n\n{why}\n\nRun \"npm run desktop:dev\" in {}, or open the installed Melodic Studio instead. This window switches to the app as soon as the server is up.",
            project().display()
        )
    }

    /// A page of plain text for the window while there is no app to show. System colours, so it
    /// follows the light or dark appearance without knowing the app's theme.
    fn page(title: &str, detail: &str) -> Url {
        let text = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let html = format!(
            "<!doctype html><meta charset=\"utf-8\"><title>Melodic Studio</title>\
             <body style=\"color-scheme: light dark; background: Canvas; color: CanvasText; font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 20vh 15vw; -webkit-user-select: none; user-select: none; cursor: default\">\
             <h1 style=\"font-size: 20px; font-weight: 600; margin: 0 0 12px\">{}</h1>\
             <p style=\"white-space: pre-line; opacity: 0.75; margin: 0\">{}</p>",
            text(title),
            text(detail)
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(html);
        Url::parse(&format!("data:text/html;charset=utf-8;base64,{encoded}")).expect("a data URL")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn reachable_only_when_something_listens() {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addrs = [listener.local_addr().unwrap()];
            assert!(reachable(&addrs));
            drop(listener);
            // Not the dropped port: Linux may hand it out again (or self-connect to it) at once.
            // Port 1 is outside the ephemeral range and nothing listens there.
            assert!(!reachable(&["127.0.0.1:1".parse().unwrap()]));
        }

        #[test]
        fn page_holds_its_text_as_text() {
            let url = page("Starting", "node <missing> & more");
            let encoded = url.as_str().strip_prefix("data:text/html;charset=utf-8;base64,").unwrap();
            let html = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap();
            assert!(html.contains("<h1 style=\"font-size: 20px; font-weight: 600; margin: 0 0 12px\">Starting</h1>"));
            assert!(html.contains("node &lt;missing&gt; &amp; more"));
        }
    }
}
