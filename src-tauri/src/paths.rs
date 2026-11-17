//! Two things about paths that differ between macOS, Windows and Linux.
//!
//! 1. How an absolute path is spelled. Git prints `C:/Users/me/repo` on Windows while
//!    Rust and the file dialogs produce `C:\Users\me\repo`. Every absolute path that is
//!    stored or sent to the window goes through `native()`, and two absolute paths are
//!    only ever compared with `same()`, never as strings. Repository-relative paths are
//!    a different thing: always `/` separated, exactly as git prints them.
//! 2. PATH. A GUI app on macOS (and some Linux launchers) starts with a bare PATH, so
//!    `git`, `ssh-add` and Git Credential Manager may not resolve. `fix_path()` adds the
//!    usual places before we spawn anything.

use std::path::{Path, PathBuf};

// ---- spelling -----------------------------------------------------------------

/// `path` with the platform's separators and no trailing one. Pure, so both flavours are testable anywhere.
fn spell(path: &str, windows: bool) -> String {
    if windows {
        let mut s = path.replace('/', "\\");
        // Keep the root of a drive (`C:\`) and of a share (`\\server\share\`) intact.
        while s.len() > 3 && s.ends_with('\\') && !s.ends_with(":\\") {
            s.pop();
        }
        s
    } else {
        let mut s = path.to_string();
        while s.len() > 1 && s.ends_with('/') {
            s.pop();
        }
        s
    }
}

/// The one spelling of an absolute path that the config file and the window see: the
/// platform's own separators. Use it on every path git prints (`rev-parse --show-toplevel`,
/// `worktree list`), which is `/` separated even on Windows.
pub fn native(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    match path.to_str() {
        Some(s) => PathBuf::from(spell(s, cfg!(windows))),
        None => path.to_path_buf(),
    }
}

/// Whether two absolute paths name the same file or folder, however each is spelled:
/// separators, case and 8.3 short names on Windows, symlinks such as `/var` on macOS.
/// Paths that do not exist (a worktree that was just removed) are compared by spelling.
pub fn same(a: impl AsRef<Path>, b: impl AsRef<Path>) -> bool {
    let (a, b) = (a.as_ref(), b.as_ref());
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        (Err(_), Err(_)) => {
            let key = |p: &Path| {
                let s = spell(&p.to_string_lossy(), cfg!(windows));
                if cfg!(windows) {
                    s.to_lowercase()
                } else {
                    s
                }
            };
            key(a) == key(b)
        }
        _ => false,
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// A path as a person typed or pasted it: surrounding quotes (Explorer's "Copy as path"
/// adds them) and a leading `~` are understood.
pub fn typed(input: &str) -> PathBuf {
    let mut s = input.trim();
    for quote in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(quote) && s.ends_with(quote) {
            s = s[1..s.len() - 1].trim();
        }
    }
    if let Some(rest) = s.strip_prefix('~') {
        if let (true, Some(home)) = (rest.is_empty() || rest.starts_with(['/', '\\']), home()) {
            return home.join(rest.trim_start_matches(['/', '\\']));
        }
    }
    PathBuf::from(s)
}

// ---- PATH -----------------------------------------------------------------------

pub fn fix_path() {
    #[cfg(unix)]
    fix_unix_path();
    #[cfg(windows)]
    fix_windows_path();
}

/// Ask the login shell what it thinks PATH is. Best effort: a profile script that hangs
/// must not keep the window from opening, so the shell gets a few seconds and no more.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::Duration;

    const MARK: &str = "__MELODIC_STUDIO_PATH__";
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    // `printenv` rather than `echo $PATH`: fish keeps PATH as a list and would print it with spaces.
    // The markers keep whatever a profile script prints out of the answer.
    let script = format!("echo {MARK}; printenv PATH; echo {MARK}");
    let mut child = crate::proc::command(&shell).args(["-l", "-c", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut pipe = child.stdout.take()?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        let _ = send.send(bytes);
    });
    let output = receive.recv_timeout(Duration::from_secs(4)).ok();
    if output.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let text = String::from_utf8_lossy(&output?).to_string();
    let mut lines = text.lines().map(str::trim).skip_while(|l| *l != MARK).skip(1);
    lines.next().filter(|l| !l.is_empty() && *l != MARK).map(String::from)
}

/// Every `<root>/<version>/<tail>` folder, newest version first. Node version managers
/// (nvm, fnm) keep each version's tools in one of these and only put it on PATH from an
/// interactive shell, which a GUI app never is.
#[cfg(unix)]
fn version_dirs(root: PathBuf, tail: &str) -> Vec<PathBuf> {
    // "v22.11.0" -> [22, 11, 0], so 22 sorts above 9.
    let numbers = |name: &str| -> Vec<u64> { name.split(|c: char| !c.is_ascii_digit()).filter_map(|n| n.parse().ok()).collect() };
    let mut found: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| (numbers(&e.file_name().to_string_lossy()), e.path().join(tail)))
        .filter(|(_, p)| p.is_dir())
        .collect();
    found.sort();
    found.reverse();
    found.into_iter().map(|(_, p)| p).collect()
}

#[cfg(unix)]
fn fix_unix_path() {
    let home = home();
    let in_home = |dirs: &[&str]| -> Vec<PathBuf> { home.iter().flat_map(|h| dirs.iter().map(move |d| h.join(d))).collect() };
    let fixed = |dirs: &[&str]| -> Vec<PathBuf> { dirs.iter().map(PathBuf::from).collect() };
    let split = |s: &std::ffi::OsStr| std::env::split_paths(s).collect::<Vec<_>>();

    // The user's own order first, when their shell will tell us.
    let mut parts: Vec<PathBuf> = login_shell_path().map(|p| split(p.as_ref())).unwrap_or_default();
    parts.extend(fixed(&["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]));
    parts.extend(in_home(&[".local/bin", ".cargo/bin"]));
    parts.extend(fixed(&["/usr/local/share/gcm-core", "/Applications/Xcode.app/Contents/Developer/usr/bin"]));
    if let Some(current) = std::env::var_os("PATH") {
        parts.extend(split(&current));
    }
    // Last, so they never shadow anything the user set up: where Linux package managers and
    // the common tool managers put programs (`claude`, `code`, language servers).
    parts.extend(fixed(&["/snap/bin", "/var/lib/flatpak/exports/bin", "/home/linuxbrew/.linuxbrew/bin", "/run/current-system/sw/bin"]));
    parts.extend(in_home(&[".nix-profile/bin", ".volta/bin", ".bun/bin", ".deno/bin", ".asdf/shims", ".local/share/mise/shims", ".npm-global/bin", "go/bin"]));
    for (root, tail) in [(".nvm/versions/node", "bin"), (".local/share/fnm/node-versions", "installation/bin"), ("Library/Application Support/fnm/node-versions", "installation/bin")] {
        parts.extend(in_home(&[root]).into_iter().flat_map(|root| version_dirs(root, tail)));
    }

    let mut seen = std::collections::HashSet::new();
    let kept = parts.into_iter().filter(|p| !p.as_os_str().is_empty() && seen.insert(p.clone()));
    if let Ok(joined) = std::env::join_paths(kept) {
        std::env::set_var("PATH", joined);
    }
}

/// Windows gives GUI apps the full PATH, so there is little to do: only add the standard
/// install folders of the tools we start when they exist and PATH does not have them
/// (Git for Windows offers "Git Bash only", which leaves git off PATH).
#[cfg(windows)]
fn fix_windows_path() {
    let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    let mut extra: Vec<PathBuf> = Vec::new();
    if crate::proc::find("git").is_none() {
        extra.extend(var("ProgramFiles").map(|p| p.join("Git").join("cmd")));
        extra.extend(var("ProgramFiles(x86)").map(|p| p.join("Git").join("cmd")));
        extra.extend(var("LOCALAPPDATA").map(|p| p.join("Programs").join("Git").join("cmd")));
    }
    // Claude Code's own installer, and npm's global folder.
    extra.extend(var("USERPROFILE").map(|p| p.join(".local").join("bin")));
    extra.extend(var("APPDATA").map(|p| p.join("npm")));

    let mut parts: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for dir in extra {
        if dir.is_dir() && !parts.iter().any(|p| same(p, &dir)) {
            parts.push(dir);
        }
    }
    if let Ok(joined) = std::env::join_paths(parts) {
        std::env::set_var("PATH", joined);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spelling() {
        // What git prints on Windows, and what we hand on.
        assert_eq!(spell("C:/Users/me/repo", true), r"C:\Users\me\repo");
        assert_eq!(spell("C:/Users/me/repo.worktrees/agent-fix/", true), r"C:\Users\me\repo.worktrees\agent-fix");
        assert_eq!(spell(r"C:\Users\me/repo\", true), r"C:\Users\me\repo");
        assert_eq!(spell("C:/", true), r"C:\");
        assert_eq!(spell("//server/share/repo", true), r"\\server\share\repo");
        // Elsewhere a backslash is an ordinary character in a name.
        assert_eq!(spell("/home/me/re\\po/", false), "/home/me/re\\po");
        assert_eq!(spell("/", false), "/");

        let here = std::env::temp_dir();
        assert_eq!(native(&here), native(native(&here)), "native() settles");
        if cfg!(windows) {
            assert_eq!(native("C:/Users/me/repo"), PathBuf::from(r"C:\Users\me\repo"));
        } else {
            assert_eq!(native("/home/me/repo/"), PathBuf::from("/home/me/repo"));
        }
    }

    #[test]
    fn same_folder_however_it_is_spelled() {
        let dir = std::env::temp_dir().join(format!("studio-paths-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        // The real path differs from the temp dir's spelling on macOS (/var -> /private/var)
        // and on Windows CI (C:\Users\RUNNER~1 -> C:\Users\runneradmin).
        let real = dir.canonicalize().unwrap();
        assert!(same(&dir, &real));
        assert!(same(dir.join("sub"), dir.join("sub").join("..").join("sub")));
        assert!(!same(&dir, dir.join("sub")));
        // Gone on both sides: fall back to the spelling.
        assert!(same(dir.join("gone"), format!("{}/", dir.join("gone").display())));
        assert!(!same(dir.join("gone"), dir.join("other")));
        assert!(!same(&dir, dir.join("gone")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn typed_paths() {
        assert_eq!(typed("  /srv/repo  "), PathBuf::from("/srv/repo"));
        assert_eq!(typed(r#""C:\Users\me\my repo""#), PathBuf::from(r"C:\Users\me\my repo"));
        assert_eq!(typed("'/srv/my repo'"), PathBuf::from("/srv/my repo"));
        assert_eq!(typed("~user/repo"), PathBuf::from("~user/repo"), "only a bare ~ is home");
        if let Some(home) = home() {
            assert_eq!(typed("~"), home);
            assert_eq!(typed("~/Source/repo"), home.join("Source/repo"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn fixing_path_keeps_what_was_there() {
        let before: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        fix_path();
        let after: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        assert!(before.iter().filter(|p| !p.as_os_str().is_empty()).all(|p| after.contains(p)), "nothing is dropped");
        assert!(after.contains(&PathBuf::from("/usr/bin")));
        let mut unique = after.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), after.len(), "no duplicates");
        assert!(crate::proc::find("git").is_some());
    }
}
