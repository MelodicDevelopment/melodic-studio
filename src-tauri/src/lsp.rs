//! Language servers. We start the server for a language (rust-analyzer,
//! typescript-language-server, ...) in the active checkout and relay its
//! JSON-RPC messages to the window; the protocol itself is spoken by the
//! frontend. A server comes from the project's own `node_modules/.bin`, then
//! from the app's data folder (where Settings installs them on request), then
//! from PATH. Nothing is bundled, and nothing is ever installed globally.

mod servers;

#[cfg(test)]
mod e2e;

use crate::commands::repo;
use crate::error::{AppError, Result};
use crate::AppState;
use serde::Serialize;
use servers::ServerInfo;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

struct Server {
    child: Child,
    stdin: ChildStdin,
    /// `program@root`: at most one server per program and checkout.
    slot: String,
}

#[derive(Default)]
pub struct Lsp {
    /// By key. A key names one process, so a late event from a stopped server can never be taken for its successor's.
    servers: Mutex<HashMap<String, Server>>,
    started: AtomicU64,
    /// Held for the length of an install or removal: the npm servers share one folder.
    installing: Mutex<()>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LspMessage {
    key: String,
    message: serde_json::Value,
}

/// The `lsp-closed` event: a server process is gone.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Closed {
    key: String,
    /// Which server it was (`typescript`, `rust`, ...), and its name for people.
    server: &'static str,
    label: &'static str,
    /// True when we stopped it; false when it exited or crashed by itself.
    expected: bool,
    /// What it said on the way out, when it went by itself.
    error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    /// Names this server process in `lsp_send` and in `lsp-message` events.
    pub key: String,
    /// The checkout folder the server was started in.
    pub root: String,
    /// False when it was already running (and so is already initialised).
    pub fresh: bool,
    /// Which server it is (`typescript`, `php`, `csharp`, `rust`, ...), and its name for people.
    pub server: &'static str,
    pub label: &'static str,
    /// Whose copy it is: the project's, the app's own, or one on PATH.
    pub source: servers::Source,
    /// For the client to send as `initializationOptions`; null when the server needs none.
    pub initialization_options: serde_json::Value,
}

/// Read one `Content-Length`-framed message. None at end of stream.
fn read_message(reader: &mut impl BufRead) -> Option<Vec<u8>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let mut body = vec![0; length?];
    reader.read_exact(&mut body).ok()?;
    Some(body)
}

fn write_message(writer: &mut impl Write, message: &serde_json::Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(message)?;
    writer.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

/// The end of what a server wrote to stderr. Servers log there freely, so it has to be read
/// all the time; only the last of it is kept, for when the server dies and we need to say why.
#[derive(Clone, Default)]
struct Tail(Arc<Mutex<Vec<u8>>>);

impl Tail {
    const KEEP: usize = 8 * 1024;

    fn follow(&self, mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<()> {
        let tail = self.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(read) = pipe.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                let mut kept = tail.0.lock().unwrap();
                kept.extend_from_slice(&chunk[..read]);
                if kept.len() > 2 * Self::KEEP {
                    let cut = kept.len() - Self::KEEP;
                    kept.drain(..cut);
                }
            }
        })
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).to_string()
    }
}

/// Why a server that went by itself did: the telling line of its error output, else how it exited.
fn last_words(tail: &Tail, stderr: Option<&std::thread::JoinHandle<()>>, status: Option<ExitStatus>) -> Option<String> {
    // Give the last of its error output a moment to arrive.
    let deadline = Instant::now() + Duration::from_millis(500);
    while stderr.is_some_and(|reader| !reader.is_finished()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    servers::error_line(&tail.text()).or_else(|| status.map(|status| format!("It stopped without saying why ({status})")))
}

/// Where the app keeps the servers it installs.
fn managed_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let data = app.path().app_data_dir().map_err(|e| AppError::msg(format!("No app data folder: {e}")))?;
    Ok(data.join("language-servers"))
}

/// Off the async runtime: these start other programs and wait for them.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| AppError::msg(e.to_string()))?
}

/// Start (or find) the language server for `language` in the active checkout.
/// Ok(None) means no server for that language is installed.
#[tauri::command]
pub async fn lsp_start(app: tauri::AppHandle, state: State<'_, AppState>, lsp: State<'_, Lsp>, id: String, language: String) -> Result<Option<Started>> {
    let root = repo(&state, &id)?.dir;
    let Some(spec) = servers::for_language(&language) else {
        return Ok(None);
    };
    let Some(launch) = servers::launch(spec, &root, &managed_dir(&app)?) else {
        return Ok(None);
    };
    let root_str = root.to_string_lossy().to_string();
    let slot = format!("{}@{root_str}", spec.program);
    let started = |key: String, fresh: bool| Started { key, root: root_str.clone(), fresh, server: spec.name, label: spec.label, source: launch.source, initialization_options: launch.initialization_options.clone() };

    let mut servers = lsp.servers.lock().unwrap();
    let running = servers.iter_mut().find(|(_, server)| server.slot == slot).map(|(key, server)| (key.clone(), matches!(server.child.try_wait(), Ok(None))));
    match running {
        Some((key, true)) => return Ok(Some(started(key, false))),
        // Dead, and its reader has not noticed yet: it will find the entry gone and say nothing more.
        Some((key, false)) => drop(servers.remove(&key)),
        None => {}
    }

    let mut child = launch.command(&root).stderr(Stdio::piped()).spawn().map_err(|e| AppError::msg(format!("Could not start {}: {e}", launch.binary.display())))?;
    let stdin = child.stdin.take().ok_or_else(|| AppError::msg("No input pipe to the language server"))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("No output pipe from the language server"))?;
    let tail = Tail::default();
    let stderr = child.stderr.take().map(|pipe| tail.follow(pipe));
    let key = format!("{slot}#{}", lsp.started.fetch_add(1, Ordering::Relaxed) + 1);
    servers.insert(key.clone(), Server { child, stdin, slot });

    let thread_key = key.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(body) = read_message(&mut reader) {
            if let Ok(message) = serde_json::from_slice::<serde_json::Value>(&body) {
                let _ = app.emit("lsp-message", LspMessage { key: thread_key.clone(), message });
            }
        }
        // Its output ended. Still in the table means nobody asked it to stop.
        let server = app.state::<Lsp>().servers.lock().unwrap().remove(&thread_key);
        let expected = server.is_none();
        let status = server.and_then(|mut server| server.child.wait().ok());
        let error = if expected { None } else { last_words(&tail, stderr.as_ref(), status) };
        let _ = app.emit("lsp-closed", Closed { key: thread_key, server: spec.name, label: spec.label, expected, error });
    });
    Ok(Some(started(key, true)))
}

#[tauri::command]
pub async fn lsp_send(lsp: State<'_, Lsp>, key: String, message: serde_json::Value) -> Result<()> {
    let mut servers = lsp.servers.lock().unwrap();
    let server = servers.get_mut(&key).ok_or_else(|| AppError::msg("That language server is not running"))?;
    write_message(&mut server.stdin, &message)?;
    Ok(())
}

fn stop(mut server: Server) {
    let _ = server.child.kill();
    let _ = server.child.wait();
}

#[tauri::command]
pub async fn lsp_stop(lsp: State<'_, Lsp>, key: String) -> Result<()> {
    let server = lsp.servers.lock().unwrap().remove(&key);
    if let Some(server) = server {
        stop(server);
    }
    Ok(())
}

/// The servers Settings lists: where a copy of each was found (the project's `node_modules/.bin`,
/// the app's own folder, PATH, or nowhere), whether that copy really runs, and whether the app
/// could install one. `id` is the repository whose active checkout counts as "the project".
#[tauri::command]
pub async fn lsp_servers(app: tauri::AppHandle, state: State<'_, AppState>, id: Option<String>) -> Result<Vec<ServerInfo>> {
    let root = id.and_then(|id| repo(&state, &id).ok()).map(|git| git.dir);
    let managed = managed_dir(&app)?;
    blocking(move || Ok(servers::list(root.as_deref(), &managed))).await
}

/// Install (or update) the app's own copy of a server, in the app data folder. Takes as long as npm or dotnet do.
#[tauri::command]
pub async fn lsp_install(app: tauri::AppHandle, name: String) -> Result<()> {
    let spec = servers::named(&name).ok_or_else(|| AppError::msg(format!("No language server called {name}")))?;
    let managed = managed_dir(&app)?;
    blocking(move || {
        let lsp = app.state::<Lsp>();
        let _one_at_a_time = lsp.installing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        servers::install(spec, &managed)
    })
    .await
}

/// Delete the app's own copy of a server, stopping it first wherever it runs.
#[tauri::command]
pub async fn lsp_uninstall(app: tauri::AppHandle, name: String) -> Result<()> {
    let spec = servers::named(&name).ok_or_else(|| AppError::msg(format!("No language server called {name}")))?;
    let managed = managed_dir(&app)?;
    blocking(move || {
        let lsp = app.state::<Lsp>();
        let _one_at_a_time = lsp.installing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // A running server keeps its files open, which on Windows stops them being deleted.
        let prefix = format!("{}@", spec.program);
        let running: Vec<Server> = {
            let mut servers = lsp.servers.lock().unwrap();
            let keys: Vec<String> = servers.iter().filter(|(_, server)| server.slot.starts_with(&prefix)).map(|(key, _)| key.clone()).collect();
            keys.iter().filter_map(|key| servers.remove(key)).collect()
        };
        running.into_iter().for_each(stop);
        servers::uninstall(spec, &managed)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames() {
        let stream = b"Content-Length: 17\r\nContent-Type: x\r\n\r\n{\"jsonrpc\":\"2.0\"}content-length: 2\r\n\r\n{}Content-Length: 99\r\n\r\n{";
        let mut reader = BufReader::new(&stream[..]);
        assert_eq!(read_message(&mut reader).unwrap(), b"{\"jsonrpc\":\"2.0\"}");
        assert_eq!(read_message(&mut reader).unwrap(), b"{}");
        assert!(read_message(&mut reader).is_none(), "a truncated body ends the stream");
    }

    #[test]
    fn writes_what_it_reads() {
        let message = serde_json::json!({ "jsonrpc": "2.0", "method": "x", "params": { "text": "héllo\n" } });
        let mut wire = Vec::new();
        write_message(&mut wire, &message).unwrap();
        write_message(&mut wire, &serde_json::json!({})).unwrap();
        let mut reader = BufReader::new(&wire[..]);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&read_message(&mut reader).unwrap()).unwrap(), message);
        assert_eq!(read_message(&mut reader).unwrap(), b"{}");
        assert!(read_message(&mut reader).is_none());
    }

    #[test]
    fn says_why_a_server_died() {
        // What a rustup stand-in for a missing rust-analyzer does: no output, a line on stderr, a failing exit.
        let mut child = crate::proc::command("git").arg("--no-such-option-anywhere").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let tail = Tail::default();
        let stderr = child.stderr.take().map(|pipe| tail.follow(pipe));
        assert!(read_message(&mut BufReader::new(child.stdout.take().unwrap())).is_none());
        let status = child.wait().ok();
        let why = last_words(&tail, stderr.as_ref(), status).unwrap();
        assert!(why.to_lowercase().contains("unknown option"), "{why}");

        // Nothing on stderr: at least how it ended.
        let quiet = crate::proc::command("git").args(["rev-parse", "--verify", "--quiet", "no-such-ref"]).current_dir(std::env::temp_dir()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().ok();
        assert!(last_words(&Tail::default(), None, quiet).unwrap().starts_with("It stopped without saying why"));
    }

    #[test]
    fn keeps_the_end_of_stderr() {
        let tail = Tail::default();
        let noise = format!("{}error: the last thing it said\n", "info: working\n".repeat(4000));
        tail.follow(std::io::Cursor::new(noise.into_bytes())).join().unwrap();
        let text = tail.text();
        assert!(text.len() <= 2 * Tail::KEEP, "{}", text.len());
        assert_eq!(servers::error_line(&text).unwrap(), "error: the last thing it said");
    }
}
