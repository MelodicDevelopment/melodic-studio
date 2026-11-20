//! Formatting with the project's own formatter (step 8 of docs/daily-driver.md).
//!
//! When a project has Prettier (in a `node_modules` of its own) and a Prettier
//! config that applies to the file, "Format document" and format on save use it:
//! the text goes in on stdin and the formatted text comes back on stdout, so the
//! file on disk is not touched and unsaved edits are what gets formatted. Nothing
//! is installed, and nothing global is used: a project without its own Prettier
//! is formatted as before, by its language server or the editor.
//!
//! Prettier is started as `node <its script>`, never through the `.bin` shim (a
//! `.cmd` on Windows), with separate arguments and a timeout. The same shape fits
//! `ruff format` and `black` when they are wanted.

use crate::error::{AppError, Result};
use crate::{files, host_cli, proc};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A project that takes longer than this to format one file has something wrong with it.
const TIMEOUT: Duration = Duration::from_secs(15);

/// The config files Prettier itself looks for (besides a `prettier` key in package.json).
const CONFIGS: &[&str] = &[
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.json5",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    ".prettierrc.toml",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.mjs",
    ".prettierrc.ts",
    ".prettierrc.cts",
    ".prettierrc.mts",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mjs",
    "prettier.config.ts",
    "prettier.config.cts",
    "prettier.config.mts",
];

/// The formatter a file's project brings, for the window to name.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: &'static str,
    pub version: Option<String>,
}

/// A project's Prettier: the folder its `node_modules` is in, and the script to run.
#[derive(Debug, PartialEq)]
struct Prettier {
    dir: PathBuf,
    script: PathBuf,
    version: Option<String>,
}

fn package_json(dir: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(dir.join("package.json")).ok()?).ok()
}

/// Whether `dir` itself holds a Prettier config.
fn has_config(dir: &Path) -> bool {
    CONFIGS.iter().any(|name| dir.join(name).is_file()) || package_json(dir).is_some_and(|p| p.get("prettier").is_some())
}

/// The Prettier installed in `dir/node_modules`, if there is one that can be run.
fn installed(dir: &Path) -> Option<Prettier> {
    let package = dir.join("node_modules").join("prettier");
    let manifest = package_json(&package)?;
    // "bin" is a path, or a table of them by command name.
    let bin = match manifest.get("bin")? {
        serde_json::Value::String(path) => path.clone(),
        serde_json::Value::Object(table) => table.get("prettier")?.as_str()?.to_string(),
        _ => return None,
    };
    let script = package.join(bin.trim_start_matches("./"));
    script.is_file().then(|| Prettier { dir: dir.to_path_buf(), script, version: manifest.get("version").and_then(|v| v.as_str()).map(str::to_string) })
}

/// The project's Prettier for `file`: the nearest one from the file's folder up to the checkout's,
/// and only when a Prettier config applies to the file (looked for the same way, never above the
/// checkout). A package of a monorepo can so bring its own, and a project that merely has Prettier
/// installed for something else, with no config, is left to its language server.
fn prettier_for(root: &Path, file: &Path) -> Option<Prettier> {
    let folders = || file.ancestors().skip(1).take_while(|dir| dir.starts_with(root));
    if !folders().any(has_config) {
        return None;
    }
    folders().find_map(installed)
}

/// The file as the checkout spells it, once `files::resolve` has found it to be inside. What
/// `resolve` answers is the real path (symlinks followed, `\\?\` in front on Windows): that one does
/// not start with `root` as it was given, and is not how Prettier should be told the file's name.
fn located(root: &Path, rel: &str) -> Result<PathBuf> {
    files::resolve(root, rel)?;
    Ok(rel.split('/').fold(root.to_path_buf(), |path, part| path.join(part)))
}

/// The formatter `rel`'s project brings, if it brings one. Looks at the disk only; nothing is started.
pub fn tool(root: &Path, rel: &str) -> Result<Option<Tool>> {
    let file = located(root, rel)?;
    Ok(prettier_for(root, &file).map(|p| Tool { name: "Prettier", version: p.version }))
}

/// What a formatter said went wrong, short enough for a toast: its first line, without its own
/// prefix and without the file's whole path in front (the window names the file).
fn complaint(stderr: &str, stdout: &str, file: &Path) -> String {
    let text = if stderr.trim().is_empty() { stdout } else { stderr };
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("it gave no reason");
    let line = line.trim_start_matches("[error]").trim();
    let named = format!("{}:", file.display());
    line.strip_prefix(named.as_str()).unwrap_or(line).trim().to_string()
}

/// `text` (what the editor holds for `rel`) as the project's formatter would write it.
/// `None` when the project brings no formatter for this file, or its formatter does not know the
/// file's language: the caller then formats it some other way. An error is the formatter's own
/// (a syntax error in the text, a broken config), in its words.
pub fn format(root: &Path, rel: &str, text: &str) -> Result<Option<String>> {
    let file = located(root, rel)?;
    let Some(prettier) = prettier_for(root, &file) else {
        return Ok(None);
    };
    let node = proc::find("node").ok_or_else(|| AppError::msg("This project formats with Prettier, which needs Node.js, and node was not found"))?;
    let mut command = proc::command(node);
    // The file's name tells Prettier the language, the config and whether the file is ignored; the text is ours.
    command.arg(&prettier.script).arg("--stdin-filepath").arg(&file).current_dir(&prettier.dir);
    let out = host_cli::run(command, Some(text.as_bytes().to_vec()), TIMEOUT, "Prettier")?;
    if out.ok {
        return Ok(Some(out.stdout));
    }
    if out.stderr.contains("No parser could be inferred") {
        return Ok(None); // not a language Prettier (with this project's plugins) formats
    }
    Err(AppError::msg(complaint(&out.stderr, &out.stdout, &file)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-format-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Left as the temp folder is spelled (/var for /private/var on macOS, an 8.3 name on Windows CI):
        // a checkout's path is not always the real one either, and the finder must not mind.
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A stand-in for Prettier's script: upper-cases what it is given, and fails the two ways Prettier does.
    const STAND_IN: &str = r#"
let text = '';
process.stdin.on('data', (chunk) => (text += chunk)).on('end', () => {
	const file = process.argv[process.argv.indexOf('--stdin-filepath') + 1];
	if (file.endsWith('.rs')) {
		console.error(`[error] No parser could be inferred for file "${file}".`);
		process.exit(2);
	}
	if (text.includes('!!')) {
		console.error(`[error] ${file}: SyntaxError: Unexpected token (1:1)\n> 1 | !!`);
		process.exit(2);
	}
	process.stdout.write(text.toUpperCase());
});
"#;

    fn install(dir: &Path, bin: &str) {
        write(&dir.join("node_modules/prettier/package.json"), &format!(r#"{{ "name": "prettier", "version": "3.9.1", "bin": {bin} }}"#));
        write(&dir.join("node_modules/prettier/bin/prettier.cjs"), STAND_IN);
    }

    #[test]
    fn the_nearest_prettier_and_only_with_a_config() {
        let root = scratch("find");
        write(&root.join("src/a.ts"), "a");
        write(&root.join("packages/app/src/b.ts"), "b");

        // Installed but not configured: the project does not format with it.
        install(&root, r#""./bin/prettier.cjs""#);
        assert_eq!(tool(&root, "src/a.ts").unwrap(), None);

        // A config at the top covers everything under it.
        write(&root.join(".prettierrc"), "{}");
        assert_eq!(tool(&root, "src/a.ts").unwrap(), Some(Tool { name: "Prettier", version: Some("3.9.1".into()) }));
        assert!(prettier_for(&root, &root.join("packages/app/src/b.ts")).unwrap().dir.ends_with(root.file_name().unwrap()));

        // A package with its own copy uses that one ("bin" as a table, as Prettier 3 writes it).
        install(&root.join("packages/app"), r#"{ "prettier": "./bin/prettier.cjs" }"#);
        let found = prettier_for(&root, &root.join("packages/app/src/b.ts")).unwrap();
        assert!(found.dir.ends_with("packages/app"), "{found:?}");
        assert!(found.script.ends_with("node_modules/prettier/bin/prettier.cjs"), "{found:?}");
        assert!(prettier_for(&root, &root.join("src/a.ts")).unwrap().dir.ends_with(root.file_name().unwrap()));

        // The config can be a key in package.json, and a copy that cannot be run does not count.
        let other = scratch("find-key");
        write(&other.join("index.js"), "x");
        write(&other.join("package.json"), r#"{ "name": "x", "prettier": { "semi": false } }"#);
        assert_eq!(tool(&other, "index.js").unwrap(), None, "nothing installed");
        write(&other.join("node_modules/prettier/package.json"), r#"{ "name": "prettier", "version": "2.8.8", "bin": "./bin-prettier.js" }"#);
        assert_eq!(tool(&other, "index.js").unwrap(), None, "its script is missing");
        write(&other.join("node_modules/prettier/bin-prettier.js"), STAND_IN);
        assert_eq!(tool(&other, "index.js").unwrap().unwrap().version.as_deref(), Some("2.8.8"));

        // The file's name goes to Prettier as the checkout spells it, not as the disk resolves it.
        assert_eq!(located(&root, "packages/app/src/b.ts").unwrap(), root.join("packages").join("app").join("src").join("b.ts"));

        // Outside the checkout is refused like any other path.
        assert!(tool(&root, "../elsewhere.ts").is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(other);
    }

    #[test]
    fn the_text_goes_in_and_the_formatted_text_comes_back() {
        if proc::find("node").is_none() {
            eprintln!("skipped: node is not installed");
            return;
        }
        let root = scratch("run");
        install(&root, r#""./bin/prettier.cjs""#);
        write(&root.join(".prettierrc.json"), "{}");
        write(&root.join("src/a.ts"), "on disk");
        write(&root.join("src/lib.rs"), "fn main() {}");
        write(&root.join("with space/b.ts"), "x");

        // What comes back is made from the text handed over (the editor's), not from the file.
        assert_eq!(format(&root, "src/a.ts", "const answer = 42;\n").unwrap().as_deref(), Some("CONST ANSWER = 42;\n"));
        assert_eq!(std::fs::read_to_string(root.join("src/a.ts")).unwrap(), "on disk", "the file itself is not touched");
        assert_eq!(format(&root, "with space/b.ts", "héllo ✓").unwrap().as_deref(), Some("HÉLLO ✓"));
        // More than a pipe holds: both ends are worked at once.
        let long = "let x = 1;\n".repeat(40_000);
        assert_eq!(format(&root, "src/a.ts", &long).unwrap().map(|t| t.len()), Some(long.len()));

        // A language it does not know is somebody else's to format; a syntax error is said in its words.
        assert_eq!(format(&root, "src/lib.rs", "fn main() {}").unwrap(), None);
        let error = format(&root, "src/a.ts", "!!").unwrap_err().to_string();
        assert_eq!(error, "SyntaxError: Unexpected token (1:1)", "its first line, without its prefix or the file's path");

        // No config, no formatting: nothing is started.
        std::fs::remove_file(root.join(".prettierrc.json")).unwrap();
        assert_eq!(format(&root, "src/a.ts", "const answer = 42;\n").unwrap(), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
