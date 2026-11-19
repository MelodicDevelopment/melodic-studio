//! Running a target (`targets.rs`): its argv on a pseudo-terminal through `terminal.rs`, in the
//! active checkout, so it shows in the bottom panel like a shell and `term_close` stops it.
//!
//! Each worktree gets a port of its own, so a copy of the app started there never collides with
//! the one running in the main checkout: `ASPNETCORE_URLS` (and Kestrel's endpoint setting, which a
//! launch profile cannot override) for .NET, `PORT` for everything else.
//! The main checkout keeps whatever port the app itself picks. A worktree's port is chosen once
//! and remembered (in the app's cache folder), so its address stays the same between runs.

use crate::commands::{main_repo, repo};
use crate::error::{AppError, Result};
use crate::targets::{self, Runtime, Target};
use crate::terminal::{self, Shell, Terminals};
use crate::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

/// The ports handed to worktrees: "<checkout>\n<target id>" -> port. Loaded from disk on first use.
#[derive(Default)]
pub struct Runs {
    ports: Mutex<Option<HashMap<String, u16>>>,
}

/// What the window learns about a run it started.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    /// The terminal key: `term-data`, `term-exit`, `term_resize` and `term_close` use it.
    pub key: String,
    /// The port this checkout's copy was told to listen on; None in the main checkout.
    pub port: Option<u16>,
    /// The command line, for showing.
    pub command: String,
}

/// A port nothing is listening on right now.
pub fn free_port() -> Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

fn is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// The port remembered under `key`, while it can still be used; else a new one from `pick`, remembered.
/// Returns the port and whether the map changed.
fn remembered(ports: &mut HashMap<String, u16>, key: &str, usable: impl Fn(u16) -> bool, pick: impl FnOnce() -> Option<u16>) -> (Option<u16>, bool) {
    if let Some(&port) = ports.get(key) {
        if usable(port) {
            return (Some(port), false);
        }
    }
    match pick() {
        Some(port) => {
            ports.insert(key.to_string(), port);
            (Some(port), true)
        }
        None => (None, false),
    }
}

fn ports_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|dir| dir.join("run-ports.json"))
}

impl Runs {
    /// The port for `target` in the worktree at `checkout`.
    pub fn port(&self, app: &tauri::AppHandle, checkout: &Path, target: &Target) -> Option<u16> {
        let file = ports_file(app);
        let mut guard = self.ports.lock().unwrap();
        let ports = guard.get_or_insert_with(|| file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default());
        let key = format!("{}\n{}", checkout.to_string_lossy(), target.id);
        // A copy that was just stopped (Restart) may hold the port for a moment longer.
        let usable = |port: u16| {
            for attempt in 0..8 {
                if is_free(port) {
                    return true;
                }
                if attempt < 7 {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            false
        };
        let (port, changed) = remembered(ports, &key, usable, || free_port().ok());
        if changed {
            // Worktrees that are gone take their ports with them.
            ports.retain(|k, _| k.split('\n').next().is_some_and(|dir| Path::new(dir).is_dir()));
            if let (Some(file), Ok(json)) = (file, serde_json::to_vec_pretty(ports)) {
                let _ = file.parent().map(std::fs::create_dir_all);
                let _ = std::fs::write(file, json);
            }
        }
        port
    }
}

/// What a copy of the app is told so it listens on `port`.
pub fn port_env(runtime: Runtime, port: u16) -> Vec<(String, String)> {
    match runtime {
        // A launch profile's own address replaces ASPNETCORE_URLS (found by running it), and Kestrel's
        // endpoint setting replaces that in turn, so both are set: the second is what holds with a profile.
        Runtime::Dotnet => {
            let url = format!("http://127.0.0.1:{port}");
            vec![("ASPNETCORE_URLS".to_string(), url.clone()), ("Kestrel__Endpoints__Http__Url".to_string(), url)]
        }
        _ => vec![("PORT".to_string(), port.to_string())],
    }
}

/// Arguments that are safe to hand to `cmd.exe /c` unquoted: a script name, a flag, a path.
fn plain_for_cmd(arg: &str) -> bool {
    !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "_-./:=@+\\".contains(c))
}

/// The folder a target runs in.
pub fn folder(checkout: &Path, target: &Target) -> Result<PathBuf> {
    let dir = target.cwd.split('/').filter(|s| !s.is_empty()).fold(checkout.to_path_buf(), |dir, part| dir.join(part));
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(AppError::msg(format!("{} no longer exists in this checkout", if target.cwd.is_empty() { "The folder" } else { &target.cwd })))
    }
}

/// `target`'s argv (plus `extra`) as a program to start in `dir`, with `env` added to its environment.
pub fn program(dir: &Path, target: &Target, extra: &[String], env: Vec<(String, String)>) -> Result<Shell> {
    let (name, rest) = target.argv.split_first().ok_or_else(|| AppError::msg("That target has nothing to run"))?;
    let args: Vec<String> = rest.iter().chain(extra).cloned().collect();
    let program = if name.contains(['/', '\\']) {
        // A program inside the project (its virtual environment's Python).
        let path = name.split('/').fold(dir.to_path_buf(), |p, part| p.join(part));
        path.is_file().then_some(path)
    } else {
        crate::proc::find(name)
    }
    .ok_or_else(|| AppError::msg(format!("`{name}` was not found. Install it and make sure it runs in a terminal, then try again.")))?;
    let env_remove = terminal::CLAUDE_MARKERS.to_vec();
    let is_script = program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if cfg!(windows) && is_script {
        // npm, pnpm and yarn are `.cmd` shims, which only `cmd.exe` can run, and it reads its arguments as a command line.
        if let Some(odd) = args.iter().find(|a| !plain_for_cmd(a)) {
            return Err(AppError::msg(format!("\"{odd}\" cannot be passed to {name} on Windows")));
        }
        let comspec = std::env::var_os("COMSPEC").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cmd.exe"));
        let mut all = vec!["/d".to_string(), "/c".to_string(), program.to_string_lossy().to_string()];
        all.extend(args);
        return Ok(Shell { program: comspec, args: all, env_remove, env });
    }
    Ok(Shell { program, args, env_remove, env })
}

/// The target with this id in the checkout, read again from its project files: the window names
/// a target, it never supplies a command line.
pub fn find(checkout: &Path, id: &str) -> Result<Target> {
    targets::discover(checkout).into_iter().find(|t| t.id == id).ok_or_else(|| AppError::msg("That run target is no longer in this checkout"))
}

pub fn command_line(target: &Target, extra: &[String]) -> String {
    target.argv.iter().chain(extra).cloned().collect::<Vec<_>>().join(" ")
}

/// Start target `target` of repository `id` in its active checkout. Output arrives as `term-data`
/// events and the end, with the exit code, as `term-exit`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn target_run(app: tauri::AppHandle, state: State<'_, AppState>, terminals: State<'_, Terminals>, runs: State<'_, Runs>, id: String, target: String, cols: u16, rows: u16) -> Result<RunStarted> {
    let checkout = repo(&state, &id)?.dir;
    let in_worktree = main_repo(&state, &id)?.1.is_some();
    let target = find(&checkout, &target)?;
    let dir = folder(&checkout, &target)?;
    let port = if in_worktree { runs.port(&app, &checkout, &target) } else { None };
    let env = port.map(|p| port_env(target.runtime, p)).unwrap_or_default();
    let shell = program(&dir, &target, &[], env)?;
    let key = terminal::start(app, &terminals, &shell, &dir, cols, rows, || {})?;
    Ok(RunStarted { key, port, command: command_line(&target, &[]) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::targets::Kind;

    fn target(argv: &[&str], cwd: &str) -> Target {
        Target { id: "t".into(), name: "t".into(), group: "g".into(), cwd: cwd.into(), argv: argv.iter().map(|a| a.to_string()).collect(), kind: Kind::Run, runtime: Runtime::Node, source: "package.json".into() }
    }

    #[test]
    fn a_free_port_is_one_nothing_listens_on() {
        assert!(free_port().unwrap() > 0);
        // A port of our own, held for the whole check: other tests bind ports too, so one that was only just
        // released can be taken again before it is looked at.
        let held = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(!is_free(port), "a port something listens on is not free");
    }

    #[test]
    fn a_worktree_keeps_its_port() {
        let mut ports = HashMap::new();
        // Chosen once ...
        assert_eq!(remembered(&mut ports, "wt\napi", |_| true, || Some(7251)), (Some(7251), true));
        // ... and remembered: nothing new is picked while it can still be used.
        assert_eq!(remembered(&mut ports, "wt\napi", |_| true, || panic!("picked again")), (Some(7251), false));
        // Another target, or another worktree, gets its own.
        assert_eq!(remembered(&mut ports, "wt\nweb", |_| true, || Some(7252)), (Some(7252), true));
        assert_eq!(remembered(&mut ports, "other\napi", |_| true, || Some(7253)), (Some(7253), true));
        // Taken by something else since: a new one replaces it.
        assert_eq!(remembered(&mut ports, "wt\napi", |p| p != 7251, || Some(7300)), (Some(7300), true));
        assert_eq!(ports["wt\napi"], 7300);
        assert_eq!(remembered(&mut ports, "new\napi", |_| true, || None), (None, false));
    }

    #[test]
    fn the_port_is_passed_the_way_each_runtime_reads_it() {
        assert_eq!(port_env(Runtime::Dotnet, 7251), [("ASPNETCORE_URLS".to_string(), "http://127.0.0.1:7251".to_string()), ("Kestrel__Endpoints__Http__Url".to_string(), "http://127.0.0.1:7251".to_string())]);
        assert_eq!(port_env(Runtime::Node, 5174), [("PORT".to_string(), "5174".to_string())]);
        assert_eq!(port_env(Runtime::Python, 8001)[0].0, "PORT");
    }

    #[test]
    fn resolves_the_program_and_keeps_the_arguments_apart() {
        let dir = std::env::temp_dir();
        let shell = program(&dir, &target(&["git", "log", "--oneline"], ""), &["-n".into(), "1 2".into()], vec![("PORT".into(), "1".into())]).unwrap();
        assert!(shell.program.is_file(), "git was resolved on PATH");
        if !cfg!(windows) {
            assert_eq!(shell.args, ["log", "--oneline", "-n", "1 2"]);
        }
        assert_eq!(shell.env, [("PORT".to_string(), "1".to_string())]);
        let missing = program(&dir, &target(&["no-such-program-anywhere", "run"], ""), &[], vec![]).unwrap_err().to_string();
        assert!(missing.contains("`no-such-program-anywhere` was not found"), "{missing}");
        assert!(program(&dir, &target(&[".venv/bin/python", "manage.py"], ""), &[], vec![]).is_err(), "a project program that is not there");
        assert!(program(&dir, &target(&[], ""), &[], vec![]).is_err());
        assert!(plain_for_cmd("test:unit") && plain_for_cmd("--launch-profile") && !plain_for_cmd("a&b") && !plain_for_cmd("a b") && !plain_for_cmd(""));
        assert_eq!(command_line(&target(&["npm", "run", "dev"], ""), &["--".into(), "x".into()]), "npm run dev -- x");
    }

    #[test]
    fn runs_in_the_targets_folder() {
        let root = std::env::temp_dir().join(format!("studio-run-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src").join("api")).unwrap();
        assert!(crate::paths::same(folder(&root, &target(&["x"], "src/api")).unwrap(), root.join("src").join("api")));
        assert!(crate::paths::same(folder(&root, &target(&["x"], "")).unwrap(), &root));
        assert!(folder(&root, &target(&["x"], "gone")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
