//! The integrated terminal: the user's own shell on a pseudo-terminal, started
//! in the active checkout. `portable-pty` gives one API over Unix ptys and
//! Windows ConPTY. Output goes to the window as `term-data` events and the end
//! of the shell as `term-exit`; the frontend (xterm.js) does all the drawing.

use crate::commands::repo;
use crate::error::{AppError, Result};
use crate::AppState;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

/// How long the shell's last output may take to arrive once the shell has ended.
/// A Unix pty reports the end of the stream by itself; ConPTY keeps the pipe
/// open until the pty is closed, so there this is simply the wait.
const DRAIN: Duration = Duration::from_millis(300);

type Writer = Arc<Mutex<Box<dyn Write + Send>>>;

/// One shell on a pseudo-terminal. Dropping it closes the pty, which hangs up
/// whatever is still attached to it.
pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Writer,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Markers Claude Code sets for the programs it starts. A dev build launched from inside a Claude Code
/// session inherits them, and a `claude` started with them believes it is nested (it then, for one,
/// saves no transcript, so the conversation could not be resumed).
pub const CLAUDE_MARKERS: &[&str] = &["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION"];

/// The program a terminal runs, with its arguments.
pub struct Shell {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Variables of ours it must not inherit.
    pub env_remove: Vec<&'static str>,
}

/// The user's shell. Unix: `$SHELL` as a login shell, so the profile runs (an
/// app started from the Dock or a launcher has almost no environment).
/// Windows: PowerShell 7, else Windows PowerShell, else `%COMSPEC%`.
pub fn shell() -> Shell {
    if cfg!(windows) {
        for name in ["pwsh.exe", "powershell.exe"] {
            if let Some(program) = crate::proc::find(name) {
                return Shell { program, args: vec!["-NoLogo".into()], env_remove: CLAUDE_MARKERS.to_vec() };
            }
        }
        let program = std::env::var_os("COMSPEC").filter(|c| !c.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cmd.exe"));
        return Shell { program, args: vec![], env_remove: CLAUDE_MARKERS.to_vec() };
    }
    let program = std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("/bin/sh"));
    Shell { program, args: vec!["-l".into()], env_remove: CLAUDE_MARKERS.to_vec() }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

fn failed(what: &str, e: impl std::fmt::Display) -> AppError {
    AppError::msg(format!("{what}: {e}"))
}

/// Start `shell` in `cwd` on a new pty. `on_data` gets the raw output as it
/// arrives (a read can end in the middle of a UTF-8 character) and `on_exit`
/// the exit code, once, after the last output.
pub fn open(shell: &Shell, cwd: &Path, cols: u16, rows: u16, mut on_data: impl FnMut(&[u8]) + Send + 'static, on_exit: impl FnOnce(Option<u32>) + Send + 'static) -> Result<Pty> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| failed("Could not open a terminal", e))?;
    let mut command = CommandBuilder::new(&shell.program);
    command.args(&shell.args);
    command.cwd(cwd);
    for name in &shell.env_remove {
        command.env_remove(name);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // A Mac app started from the Dock has no locale, and without one the shell garbles anything that is not ASCII.
    if cfg!(target_os = "macos") && ["LC_ALL", "LC_CTYPE", "LANG"].iter().all(|name| std::env::var_os(name).is_none_or(|v| v.is_empty())) {
        command.env("LANG", "en_US.UTF-8");
    }
    let mut child = pair.slave.spawn_command(command).map_err(|e| failed(&format!("Could not start {}", shell.program.display()), e))?;
    // Our copy of the shell's end has to go, or the output never reports that the shell is gone.
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| failed("Could not read from the terminal", e))?;
    let writer = pair.master.take_writer().map_err(|e| failed("Could not write to the terminal", e))?;

    let over = Arc::new(AtomicBool::new(false));
    let (drained, wait_drained) = mpsc::channel::<()>();
    let reader_over = over.clone();
    std::thread::spawn(move || {
        let _drained = drained; // dropped, and so signalled, when the stream ends
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) if !reader_over.load(Ordering::SeqCst) => on_data(&buf[..n]),
                Ok(_) => break,
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    });
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|status| status.exit_code());
        let _ = wait_drained.recv_timeout(DRAIN);
        over.store(true, Ordering::SeqCst);
        on_exit(code);
    });
    Ok(Pty { master: pair.master, writer: Arc::new(Mutex::new(writer)), killer })
}

impl Pty {
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(size(cols, rows)).map_err(|e| failed("Could not resize the terminal", e))
    }

    /// End the shell: a hangup on Unix (what closing a terminal window does),
    /// TerminateProcess on Windows. Dropping the pty afterwards takes its children along.
    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

fn write_to(writer: &Writer, data: &[u8]) -> Result<()> {
    let mut writer = writer.lock().unwrap();
    writer.write_all(data)?;
    writer.flush()?;
    Ok(())
}

// ---- commands ---------------------------------------------------------------

#[derive(Default)]
pub struct Terminals {
    open: Mutex<HashMap<String, Pty>>,
    last: AtomicU64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TermData {
    key: String,
    /// Base64 of the raw bytes, so a character split across two reads survives the trip.
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TermExit {
    key: String,
    /// The shell's exit code, when the system reported one.
    code: Option<u32>,
}

/// Open a terminal in the active checkout of repository `id`. Returns the key
/// that names it in the other commands and in `term-data` / `term-exit` events.
#[tauri::command]
pub async fn term_open(app: tauri::AppHandle, state: State<'_, AppState>, terminals: State<'_, Terminals>, id: String, cols: u16, rows: u16) -> Result<String> {
    let dir = repo(&state, &id)?.dir;
    if !dir.is_dir() {
        return Err(AppError::msg("That folder no longer exists"));
    }
    start(app, &terminals, &shell(), &dir, cols, rows, || {})
}

/// Run `program` in `dir` on a new pty under a new key. `on_end` runs once the program has ended.
pub fn start(app: tauri::AppHandle, terminals: &Terminals, program: &Shell, dir: &Path, cols: u16, rows: u16, on_end: impl FnOnce() + Send + 'static) -> Result<String> {
    let key = format!("term-{}", terminals.last.fetch_add(1, Ordering::SeqCst) + 1);
    let (data_app, data_key) = (app.clone(), key.clone());
    let (exit_app, exit_key) = (app, key.clone());
    // Held until the terminal is registered, so a program that dies at once still finds itself in the map.
    let mut open_terminals = terminals.open.lock().unwrap();
    let pty = open(
        program,
        dir,
        cols,
        rows,
        move |bytes| {
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            let _ = data_app.emit("term-data", TermData { key: data_key.clone(), data });
        },
        move |code| {
            let gone = exit_app.state::<Terminals>().open.lock().unwrap().remove(&exit_key);
            drop(gone);
            on_end();
            let _ = exit_app.emit("term-exit", TermExit { key: exit_key, code });
        },
    )?;
    open_terminals.insert(key.clone(), pty);
    Ok(key)
}

/// Keystrokes (or a paste) for the shell.
#[tauri::command]
pub async fn term_write(terminals: State<'_, Terminals>, key: String, data: String) -> Result<()> {
    // Written outside the map lock: a shell that is not reading must not hold up the other terminals.
    let writer = terminals.open.lock().unwrap().get(&key).map(|pty| pty.writer.clone()).ok_or_else(|| AppError::msg("That terminal is closed"))?;
    write_to(&writer, data.as_bytes())
}

#[tauri::command]
pub async fn term_resize(terminals: State<'_, Terminals>, key: String, cols: u16, rows: u16) -> Result<()> {
    match terminals.open.lock().unwrap().get(&key) {
        Some(pty) => pty.resize(cols, rows),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn term_close(terminals: State<'_, Terminals>, key: String) -> Result<()> {
    let pty = terminals.open.lock().unwrap().remove(&key);
    if let Some(mut pty) = pty {
        pty.kill();
    }
    Ok(())
}

/// No shell outlives the window.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) {
        let all: Vec<Pty> = window.state::<Terminals>().open.lock().unwrap().drain().map(|(_, pty)| pty).collect();
        for mut pty in all {
            pty.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// A shell with no profile and no prompt theme, so what it prints is predictable.
    fn plain_shell() -> Shell {
        if cfg!(windows) {
            Shell { program: std::env::var_os("COMSPEC").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cmd.exe")), args: vec![], env_remove: vec![] }
        } else {
            Shell { program: PathBuf::from("/bin/sh"), args: vec![], env_remove: vec![] }
        }
    }

    struct Session {
        pty: Pty,
        output: mpsc::Receiver<Vec<u8>>,
        exit: mpsc::Receiver<Option<u32>>,
        seen: String,
    }

    fn start() -> Session {
        let (data, output) = mpsc::channel();
        let (done, exit) = mpsc::channel();
        let pty = open(
            &plain_shell(),
            &std::env::temp_dir(),
            80,
            24,
            move |bytes| {
                let _ = data.send(bytes.to_vec());
            },
            move |code| {
                let _ = done.send(code);
            },
        )
        .unwrap();
        Session { pty, output, exit, seen: String::new() }
    }

    impl Session {
        fn write(&self, data: &[u8]) {
            write_to(&self.pty.writer, data).unwrap();
        }

        /// Read output until `text` shows up in it.
        fn wait_for(&mut self, text: &str) -> bool {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !self.seen.contains(text) {
                let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                    return false;
                };
                let Ok(bytes) = self.output.recv_timeout(left) else {
                    return false;
                };
                let chunk = String::from_utf8_lossy(&bytes).to_string();
                // ConPTY asks where the cursor is before it shows anything; xterm.js answers that in the app.
                if chunk.contains("\x1b[6n") {
                    self.write(b"\x1b[1;1R");
                }
                self.seen.push_str(&chunk);
            }
            true
        }
    }

    #[test]
    fn runs_a_command_and_ends() {
        let mut session = start();
        // The escape character keeps the echoed keystrokes from matching: only what `echo` prints reads "studio-pty-ok".
        let line: &[u8] = if cfg!(windows) { b"echo studio^-pty-ok\r" } else { b"echo studio\\-pty-ok\r" };
        session.write(line);
        assert!(session.wait_for("studio-pty-ok"), "no output from echo, got: {:?}", session.seen);
        session.pty.resize(100, 30).unwrap();
        session.write(b"exit\r");
        assert_eq!(session.exit.recv_timeout(Duration::from_secs(30)), Ok(Some(0)), "the shell ended");
    }

    #[test]
    fn kill_ends_the_shell() {
        let mut session = start();
        session.write(b"echo ready\r");
        assert!(session.wait_for("ready"));
        session.pty.kill();
        assert!(session.exit.recv_timeout(Duration::from_secs(30)).is_ok(), "the shell was still running after kill");
    }

    #[test]
    fn finds_a_shell() {
        let shell = shell();
        assert!(shell.program.is_file() || crate::proc::find(&shell.program.to_string_lossy()).is_some(), "{} does not exist", shell.program.display());
    }
}
