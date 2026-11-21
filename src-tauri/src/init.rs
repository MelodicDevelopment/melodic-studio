//! Turning a plain folder into a repository: look at what is in it, then
//! `git init` with the choices the setup wizard collected (default branch,
//! .gitignore, README, first commit).

use crate::commands::{register, RepoSummary};
use crate::error::{AppError, Result};
use crate::git::Git;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    /// The folder as an absolute path (the repository's top level when it is inside one).
    pub path: String,
    pub name: String,
    pub exists: bool,
    /// Already a git repository (or inside one): nothing to set up.
    pub is_repo: bool,
    /// Entries directly inside it, hidden ones included.
    pub entries: usize,
    pub has_readme: bool,
    pub has_gitignore: bool,
    /// .gitignore templates that fit what is in the folder (`node`, `rust`, ...).
    pub detected: Vec<String>,
    /// Every template on offer, as (id, label).
    pub templates: Vec<(String, String)>,
    /// `init.defaultBranch` from the user's git config, else `main`.
    pub default_branch: String,
    /// The user's global git identity; empty when git does not know who they are yet.
    pub author_name: String,
    pub author_email: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InitOptions {
    pub branch: String,
    /// Template ids to write into .gitignore.
    pub gitignore: Vec<String>,
    pub readme: bool,
    /// Commit whatever is in the folder (after .gitignore applies) as the first commit.
    pub commit: bool,
    pub message: String,
    /// Set for this repository only, when git has no global identity to commit with.
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub author_email: Option<String>,
}

/// (id, label, marker files that suggest it, lines)
const TEMPLATES: &[(&str, &str, &[&str], &str)] = &[
    ("os", "macOS, Windows and Linux files", &[], ".DS_Store\nThumbs.db\ndesktop.ini\n*~\n"),
    ("editors", "Editor folders", &[], ".idea/\n.vscode/*\n!.vscode/extensions.json\n!.vscode/settings.json\n*.swp\n"),
    ("node", "Node.js / JavaScript / TypeScript", &["package.json"], "node_modules/\ndist/\nbuild/\ncoverage/\n.env\n.env.local\n*.log\n*.tsbuildinfo\n"),
    ("dotnet", ".NET / C#", &["*.sln", "*.csproj", "*.fsproj", "global.json"], "bin/\nobj/\n*.user\n*.suo\n.vs/\nTestResults/\n*.nupkg\n"),
    ("php", "PHP / Composer", &["composer.json"], "vendor/\n.env\n.phpunit.result.cache\n*.cache\n"),
    ("rust", "Rust", &["Cargo.toml"], "target/\n**/*.rs.bk\n"),
    ("python", "Python", &["pyproject.toml", "requirements.txt", "setup.py"], "__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.pytest_cache/\n*.egg-info/\n.env\n"),
    ("go", "Go", &["go.mod"], "bin/\n*.test\n*.out\n"),
    ("java", "Java / Kotlin", &["pom.xml", "build.gradle", "build.gradle.kts"], "target/\nbuild/\n.gradle/\n*.class\n"),
];

fn matches(dir: &Path, marker: &str) -> bool {
    match marker.strip_prefix("*.") {
        Some(ext) => std::fs::read_dir(dir).map(|it| it.flatten().any(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)))).unwrap_or(false),
        None => dir.join(marker).exists(),
    }
}

pub fn inspect(path: &Path) -> FolderInfo {
    let exists = path.is_dir();
    let top = if exists { Git::toplevel(path).ok() } else { None };
    let dir = top.clone().unwrap_or_else(|| path.to_path_buf());
    let names: Vec<String> = std::fs::read_dir(&dir).map(|it| it.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    let has = |want: &str| names.iter().any(|n| n.eq_ignore_ascii_case(want));
    let mut detected: Vec<String> = TEMPLATES.iter().filter(|t| t.2.iter().any(|m| matches(&dir, m))).map(|t| t.0.to_string()).collect();
    detected.insert(0, "os".into());
    let branch = Git::global_config("init.defaultBranch");
    FolderInfo {
        path: dir.to_string_lossy().to_string(),
        name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        exists,
        is_repo: top.is_some(),
        entries: names.len(),
        has_readme: has("README.md") || has("README") || has("README.txt"),
        has_gitignore: has(".gitignore"),
        detected,
        templates: TEMPLATES.iter().map(|t| (t.0.to_string(), t.1.to_string())).collect(),
        default_branch: if branch.is_empty() { "main".into() } else { branch },
        author_name: Git::global_config("user.name"),
        author_email: Git::global_config("user.email"),
    }
}

fn gitignore(ids: &[String]) -> String {
    let mut out = String::new();
    for t in TEMPLATES.iter().filter(|t| ids.iter().any(|id| id == t.0)) {
        out.push_str(&format!("# {}\n{}\n", t.1, t.3));
    }
    out
}

/// Initialise `path` (created if missing) and make the first commit if asked.
/// Existing files are never overwritten: .gitignore is appended to, README is only written when there is none.
pub fn init(path: &Path, options: &InitOptions) -> Result<Git> {
    let branch = options.branch.trim();
    if branch.is_empty() || branch.starts_with('-') || branch.contains(char::is_whitespace) || branch.contains("..") {
        return Err(AppError::msg("Give the default branch a simple name, like main"));
    }
    // A folder that does not exist yet can still sit inside a repository: check the nearest one that does.
    let existing = path.ancestors().find(|p| p.is_dir());
    if existing.is_some_and(|p| Git::toplevel(p).is_ok()) {
        return Err(AppError::msg("That folder is already inside a git repository"));
    }
    std::fs::create_dir_all(path)?;
    let git = Git::at(path);
    git.run(&["init", "-q", "-b", branch])?;
    for (key, value) in [("user.name", &options.author_name), ("user.email", &options.author_email)] {
        if let Some(value) = value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            git.run(&["config", key, value])?;
        }
    }

    let rules = gitignore(&options.gitignore);
    if !rules.is_empty() {
        let file = path.join(".gitignore");
        let mut text = std::fs::read_to_string(&file).unwrap_or_default();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&rules);
        std::fs::write(file, text)?;
    }
    let info = inspect(path);
    if options.readme && !info.has_readme {
        std::fs::write(path.join("README.md"), format!("# {}\n", info.name))?;
    }
    if options.commit {
        let files: Vec<String> = git.status()?.files.into_iter().map(|f| f.path).collect();
        if !files.is_empty() {
            let message = if options.message.trim().is_empty() { "Initial commit" } else { options.message.trim() };
            git.commit(&files, message, "", false)?;
        }
    }
    Ok(git)
}

// ---- commands ---------------------------------------------------------------

#[tauri::command]
pub async fn folder_inspect(path: String) -> Result<FolderInfo> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err(AppError::msg("Give the full path to the folder"));
    }
    Ok(inspect(&path))
}

#[tauri::command]
pub async fn repo_init(app: tauri::AppHandle, state: State<'_, AppState>, path: String, options: InitOptions) -> Result<RepoSummary> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err(AppError::msg("Give the full path to the folder"));
    }
    let git = init(&path, &options)?;
    let top = Git::toplevel(&git.dir)?;
    register(&app, &state, &top)
}

/// Open a web page (the "create a repository" page of a host). Only https links.
#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://") {
        return Err(AppError::msg("Only https links can be opened"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| AppError::msg(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-init-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn options(commit: bool) -> InitOptions {
        InitOptions {
            branch: "trunk".into(),
            gitignore: vec!["os".into(), "node".into()],
            readme: true,
            commit,
            message: String::new(),
            // The first commit must not depend on the machine having a git identity.
            author_name: Some("Test".into()),
            author_email: Some("test@example.com".into()),
        }
    }

    #[test]
    fn empty_folder_becomes_a_repository() {
        let dir = scratch("empty");
        let info = inspect(&dir);
        assert!(!info.exists && !info.is_repo);

        // No signing prompts in tests, whatever the machine's global config says.
        std::env::set_var("GIT_CONFIG_COUNT", "1");
        std::env::set_var("GIT_CONFIG_KEY_0", "commit.gpgsign");
        std::env::set_var("GIT_CONFIG_VALUE_0", "false");
        let git = init(&dir, &options(true)).unwrap();
        let info = inspect(&dir);
        assert!(info.is_repo && info.has_readme && info.has_gitignore);
        let st = git.status().unwrap();
        assert_eq!(st.branch, "trunk");
        assert!(st.has_commits && st.files.is_empty(), "everything went into the first commit");
        assert_eq!(git.log(0, 5).unwrap()[0].summary, "Initial commit");
        assert!(std::fs::read_to_string(dir.join(".gitignore")).unwrap().contains("node_modules/"));
        assert_eq!(std::fs::read_to_string(dir.join("README.md")).unwrap(), format!("# {}\n", info.name));
        assert!(init(&dir, &options(false)).is_err(), "already a repository");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_files_are_kept_and_detected() {
        let dir = scratch("existing");
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join("App.csproj"), "<Project/>").unwrap();
        std::fs::write(dir.join("README.md"), "mine\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "secret.txt").unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), "").unwrap();

        let info = inspect(&dir);
        assert_eq!(info.detected, ["os", "node", "dotnet"]);
        assert!(info.has_readme && info.has_gitignore && !info.is_repo);
        assert_eq!(info.entries, 5);

        let git = init(&dir, &InitOptions { gitignore: info.detected.clone(), branch: "main".into(), ..options(false) }).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("README.md")).unwrap(), "mine\n", "an existing README is left alone");
        let ignore = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(ignore.starts_with("secret.txt\n") && ignore.contains("node_modules/") && ignore.contains("obj/"));
        let files: Vec<String> = git.status().unwrap().files.into_iter().map(|f| f.path).collect();
        assert!(files.contains(&"package.json".to_string()));
        assert!(!files.iter().any(|f| f.starts_with("node_modules")), "ignored before the first commit");
        assert!(init(&dir.join("sub").join("deeper"), &options(false)).is_err(), "no nested repository by accident");
        assert!(init(&scratch("bad"), &InitOptions { branch: "-x".into(), ..options(false) }).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
