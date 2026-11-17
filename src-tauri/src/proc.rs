//! Starting other programs, the same way on macOS, Windows and Linux.
//! Every process the app spawns should come from `command()`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The file names a bare program name can have. On Windows `git` is `git.exe` and
/// npm-installed tools are `.cmd` shims, neither of which `Command::new("name")` finds reliably.
fn candidates(program: &str) -> Vec<String> {
    if cfg!(windows) && Path::new(program).extension().is_none() {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        exts.split(';').filter(|e| !e.is_empty()).map(|e| format!("{program}{}", e.to_ascii_lowercase())).collect()
    } else {
        vec![program.to_string()]
    }
}

/// `program` inside one folder, with the platform's executable extensions tried.
pub fn find_in(dir: &Path, program: &str) -> Option<PathBuf> {
    candidates(program).into_iter().map(|name| dir.join(name)).find(|p| p.is_file())
}

/// `program` on PATH.
pub fn find(program: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).find_map(|dir| find_in(&dir, program))
}

/// A `Command` for a program name or path. Bare names are resolved on PATH first
/// (so `.cmd` shims work on Windows), and no console window flashes up on Windows.
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
        assert!(command("git").arg("--version").output().unwrap().status.success());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
