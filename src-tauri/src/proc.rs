//! Starting other programs, the same way on macOS, Windows and Linux.
//! Every process the app spawns should come from `command()`, and a process that is
//! stopped on purpose should go through `kill_tree()`.

use crate::error::{AppError, Result};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// What Windows can start directly. PATHEXT also lists script types (.JS, .VBS, .PY)
/// that only the shell knows how to open.
const WINDOWS_EXECUTABLE: [&str; 4] = [".com", ".exe", ".bat", ".cmd"];

/// The file names a bare program name can have. On Windows `git` is `git.exe` and
/// npm-installed tools are `.cmd` shims, neither of which `Command::new("name")` finds
/// reliably; the extension-less file npm puts beside the shim is a shell script that
/// Windows cannot run at all. `pathext` is the PATHEXT variable; its order is kept.
fn file_names(program: &str, windows: bool, pathext: Option<&str>) -> Vec<String> {
    if !windows {
        return vec![program.to_string()];
    }
    let lower = program.to_ascii_lowercase();
    if WINDOWS_EXECUTABLE.iter().any(|ext| lower.ends_with(ext)) {
        return vec![program.to_string()];
    }
    let listed: Vec<String> = pathext.unwrap_or_default().split(';').map(|e| e.trim().to_ascii_lowercase()).filter(|e| WINDOWS_EXECUTABLE.contains(&e.as_str())).collect();
    let extensions = if listed.is_empty() { WINDOWS_EXECUTABLE.iter().map(|e| e.to_string()).collect() } else { listed };
    extensions.iter().map(|ext| format!("{program}{ext}")).collect()
}

fn is_program(path: &Path) -> bool {
    // App execution aliases (`wt.exe`, a Store-installed `python.exe`) are reparse points
    // that cannot be opened like a file, so `is_file` says no although they start fine.
    path.is_file() || (cfg!(windows) && path.symlink_metadata().is_ok_and(|m| !m.is_dir()))
}

/// `program` inside one folder, with the platform's executable extensions tried.
pub fn find_in(dir: &Path, program: &str) -> Option<PathBuf> {
    let pathext = std::env::var("PATHEXT").ok();
    file_names(program, cfg!(windows), pathext.as_deref()).into_iter().map(|name| dir.join(name)).find(|p| is_program(p))
}

/// `program` on PATH.
pub fn find(program: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    // An empty entry means "the current folder", which is never where we want to find a tool.
    std::env::split_paths(&paths).filter(|dir| !dir.as_os_str().is_empty()).find_map(|dir| find_in(&dir, program))
}

/// A `Command` for a program name or path. Bare names are resolved on PATH first
/// (so `.cmd` shims work on Windows), and no console window flashes up on Windows.
///
/// A `.cmd`/`.bat` program is run through `cmd.exe` by Rust, which refuses arguments
/// holding a line break: pass anything free-form (a prompt, a message) on stdin instead.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let program = program.as_ref();
    let resolved = program.to_str().filter(|p| !p.contains(['/', '\\'])).and_then(find);
    let c = match resolved {
        Some(path) => Command::new(path),
        None => Command::new(program),
    };
    #[cfg(windows)]
    let c = {
        use std::os::windows::process::CommandExt;
        let mut c = c;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    c
}

/// Stop a child and everything it started. On Windows an npm `.cmd` shim runs as
/// `cmd.exe` -> `node.exe`; killing only the child would leave node (the agent, the
/// language server) running with nothing attached to it.
pub fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = command("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
}

/// Start a program the user carries on with by themselves (a terminal):
/// nothing is piped to or from it, and it is reaped when it exits so no zombie is left.
pub fn launch(mut c: Command) -> std::io::Result<()> {
    let mut child = c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// The argument `relaunch()` starts this app's own binary with: `--relaunch-after <pid> <bundle>`.
const RELAUNCH_FLAG: &str = "--relaunch-after";

/// Start this app again once the current process has ended (macOS, after an update).
///
/// Tauri's own restart runs `open -n <bundle>` while the old instance is still alive, so
/// LaunchServices registers a second instance and the Dock gives it its own icon beside the
/// pinned one. Instead the app's binary is started as a small helper (`relaunch_helper`) that
/// waits for this process to be gone and then runs a plain `open <bundle>`, which the Dock
/// matches to the pinned icon. The binary is the one now in the bundle, i.e. the new version:
/// every later version must keep understanding the flag.
///
/// Returns an error where this does not apply (other platforms, not inside a `.app`); the
/// caller then falls back to Tauri's restart. On success the caller must exit.
pub fn relaunch() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        let exe = std::env::current_exe()?;
        let bundle = exe
            .parent()
            .filter(|d| d.ends_with("Contents/MacOS"))
            .and_then(|d| d.parent()?.parent())
            .filter(|b| b.extension().is_some_and(|e| e == "app"))
            .ok_or_else(|| AppError::msg("not running from an app bundle"))?;
        let mut c = command(&exe);
        c.arg(RELAUNCH_FLAG).arg(std::process::id().to_string()).arg(bundle).process_group(0);
        launch(c)?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Err(AppError::msg("relaunch helper is macOS only"))
}

/// The other half of `relaunch()`: true when this process was started as the helper, which
/// has then done its work. Called first thing in `run()`, before any window or setup.
pub fn relaunch_helper() -> bool {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_none_or(|a| a != RELAUNCH_FLAG) {
        return false;
    }
    #[cfg(target_os = "macos")]
    if let [_, pid, bundle] = args.as_slice() {
        if let Some(pid) = pid.to_str().and_then(|p| p.parse::<libc::pid_t>().ok()) {
            // Wait (up to 10 s) for the old instance to be gone, then a moment for LaunchServices to notice.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while unsafe { libc::kill(pid, 0) } == 0 && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
            let _ = Command::new("/usr/bin/open").arg(bundle).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
    }
    true
}

/// Split a command line the way a person writes one: on spaces, with "double" or 'single'
/// quotes around anything that contains them. No escapes, so Windows backslashes stay as they are.
/// Used for `$TERMINAL` on Linux.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
pub fn split_command(line: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    for ch in line.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                started = true;
            }
            None if ch.is_whitespace() => {
                if started {
                    parts.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => {
                current.push(ch);
                started = true;
            }
        }
    }
    if started {
        parts.push(current);
    }
    parts
}

// ---- a terminal -----------------------------------------------------------------

/// Terminal emulators on Linux and how each is told where to start; `{}` is the folder.
/// There is no one command for "the terminal" there, so we try what is installed.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
const LINUX_TERMINALS: &[(&str, &[&str])] = &[
    // Debian and Ubuntu's pointer to the user's default terminal.
    ("x-terminal-emulator", &[]),
    ("ptyxis", &["--new-window", "--working-directory={}"]),
    ("kgx", &["--working-directory={}"]),
    ("gnome-terminal", &["--working-directory={}"]),
    ("konsole", &["--workdir", "{}"]),
    ("xfce4-terminal", &["--working-directory={}"]),
    ("mate-terminal", &["--working-directory={}"]),
    ("tilix", &["--working-directory={}"]),
    ("lxterminal", &["--working-directory={}"]),
    ("qterminal", &["--workdir", "{}"]),
    ("wezterm", &["start", "--cwd", "{}"]),
    ("kitty", &["--directory", "{}"]),
    ("alacritty", &["--working-directory", "{}"]),
    ("foot", &["--working-directory={}"]),
    ("xterm", &[]),
];

/// The terminals to try, best first: `$TERMINAL` if set, then the desktop's own
/// (`XDG_CURRENT_DESKTOP`), then the rest. Each is (program, arguments).
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn linux_terminals(dir: &str, terminal_var: Option<&str>, desktop: &str) -> Vec<(String, Vec<String>)> {
    let desktop = desktop.to_ascii_lowercase();
    let native: &[&str] = if desktop.contains("kde") {
        &["konsole"]
    } else if desktop.contains("xfce") {
        &["xfce4-terminal"]
    } else if desktop.contains("mate") {
        &["mate-terminal"]
    } else if desktop.contains("lxqt") {
        &["qterminal"]
    } else if desktop.contains("lxde") {
        &["lxterminal"]
    } else {
        &[]
    };
    let mut list: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(mut custom) = terminal_var.map(split_command).filter(|c| !c.is_empty()) {
        let program = custom.remove(0);
        list.push((program, custom));
    }
    let known = |name: &str| LINUX_TERMINALS.iter().find(|(n, _)| *n == name);
    let rest = LINUX_TERMINALS.iter().filter(|(n, _)| !native.contains(n));
    for (name, args) in native.iter().filter_map(|n| known(n)).chain(rest) {
        list.push((name.to_string(), args.iter().map(|a| a.replace("{}", dir)).collect()));
    }
    list
}

#[cfg(target_os = "macos")]
fn terminals(dir: &str) -> Vec<Command> {
    let mut c = command("open");
    c.args(["-a", "Terminal", dir]);
    vec![c]
}

#[cfg(windows)]
fn terminals(dir: &str) -> Vec<Command> {
    // Windows Terminal where it is installed (it is on Windows 11) ...
    let mut wt = command("wt");
    wt.args(["-d", dir]);
    // ... else a plain console. `start` gives it a window of its own; our hidden `cmd` only launches it.
    let mut cmd = command("cmd");
    cmd.args(["/C", "start", "cmd"]).current_dir(dir);
    vec![wt, cmd]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn terminals(dir: &str) -> Vec<Command> {
    let terminal = std::env::var("TERMINAL").ok();
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    linux_terminals(dir, terminal.as_deref(), &desktop)
        .into_iter()
        .filter(|(program, _)| program.contains('/') || find(program).is_some())
        .map(|(program, args)| {
            let mut c = command(program);
            // Most also start in the folder they are launched from; the flag covers the ones that hand off to a server.
            c.args(args).current_dir(dir);
            c
        })
        .collect()
}

/// Open a terminal window in `dir`.
pub fn open_terminal(dir: &str) -> Result<()> {
    if terminals(dir).into_iter().any(|c| launch(c).is_ok()) {
        return Ok(());
    }
    Err(AppError::msg(if cfg!(all(unix, not(target_os = "macos"))) {
        "Could not find a terminal to open. Set the TERMINAL environment variable to the one you use."
    } else {
        "Could not open a terminal"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_programs() {
        assert!(find("git").is_some(), "git is on PATH wherever the tests run");
        assert!(find("no-such-program-anywhere").is_none());
        let dir = std::env::temp_dir().join(format!("studio-proc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = if cfg!(windows) { "tool.cmd" } else { "tool" };
        std::fs::write(dir.join(name), "").unwrap();
        assert_eq!(find_in(&dir, "tool").unwrap(), dir.join(name));
        assert!(find_in(&dir, "other").is_none());
        assert!(command("git").arg("--version").output().unwrap().status.success());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_file_names() {
        let pathext = Some(".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PY");
        assert_eq!(file_names("git", false, pathext), ["git"]);
        // Only what Windows can start itself, in PATHEXT's order; never the bare name (npm's shell script).
        assert_eq!(file_names("claude", true, pathext), ["claude.com", "claude.exe", "claude.bat", "claude.cmd"]);
        assert_eq!(file_names("claude", true, Some(".CMD;.EXE")), ["claude.cmd", "claude.exe"]);
        assert_eq!(file_names("claude", true, None), ["claude.com", "claude.exe", "claude.bat", "claude.cmd"]);
        assert_eq!(file_names("code.cmd", true, pathext), ["code.cmd"]);
        assert_eq!(file_names("Git.EXE", true, pathext), ["Git.EXE"]);
        // A dot in the name is not an extension.
        assert_eq!(file_names("python3.12", true, Some(".EXE")), ["python3.12.exe"]);
    }

    #[test]
    fn splits_command_lines() {
        assert_eq!(split_command("code"), ["code"]);
        assert_eq!(split_command("  cursor   --reuse-window "), ["cursor", "--reuse-window"]);
        assert_eq!(split_command(r#""C:\Program Files\Editor\editor.exe" -n"#), [r"C:\Program Files\Editor\editor.exe", "-n"]);
        assert_eq!(split_command("'/Applications/My Editor.app/Contents/MacOS/editor' --wait"), ["/Applications/My Editor.app/Contents/MacOS/editor", "--wait"]);
        assert_eq!(split_command(r#"editor --title="a b" """#), ["editor", "--title=a b", ""]);
        assert!(split_command("   ").is_empty());
    }

    #[test]
    fn linux_terminal_order() {
        let names = |list: Vec<(String, Vec<String>)>| list.into_iter().map(|(n, _)| n).collect::<Vec<_>>();
        let gnome = linux_terminals("/srv/my repo", None, "ubuntu:GNOME");
        assert_eq!(gnome[0].0, "x-terminal-emulator");
        let (_, args) = gnome.iter().find(|(n, _)| n == "gnome-terminal").unwrap();
        assert_eq!(args, &["--working-directory=/srv/my repo"], "the folder is one argument, spaces and all");

        let kde = names(linux_terminals("/srv/repo", None, "KDE"));
        assert_eq!(kde[0], "konsole");
        assert_eq!(kde.iter().filter(|n| *n == "konsole").count(), 1);
        assert_eq!(kde.len(), LINUX_TERMINALS.len());

        let custom = linux_terminals("/srv/repo", Some("kitty --single-instance"), "");
        assert_eq!(custom[0], ("kitty".to_string(), vec!["--single-instance".to_string()]));
    }
}
