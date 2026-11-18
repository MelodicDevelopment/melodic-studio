//! Tauri commands. Thin: look up the repository, delegate to `git`.
//! Everything that runs git is `async` so a slow fetch never blocks the window.

use crate::config::RepoRef;
use crate::error::{AppError, Result};
use crate::git::{self, Branch, Commit, DiffResult, FileChange, FileRef, Git, Identity, RebaseStep, RepoStatus, UndoneCommit};
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    /// The folder is gone or no longer a repository.
    pub missing: bool,
    /// Set while the app is looking at a linked worktree instead of the main checkout.
    pub worktree: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub repos: Vec<RepoSummary>,
    pub current: Option<String>,
    pub git_version: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub app_version: String,
}

fn summary(r: &RepoRef) -> RepoSummary {
    RepoSummary { id: r.id.clone(), name: r.name.clone(), path: r.path.to_string_lossy().to_string(), missing: !r.path.join(".git").exists(), worktree: r.worktree.as_ref().filter(|w| w.is_dir()).map(|w| w.to_string_lossy().to_string()) }
}

/// Only repositories the user added can be operated on.
pub(crate) fn repo(state: &State<'_, AppState>, id: &str) -> Result<Git> {
    let config = state.config.lock().unwrap();
    let r = config.find(id).ok_or_else(|| AppError::msg("That repository is no longer in Melodic Studio"))?;
    Ok(Git::at(r.active_path()))
}

/// The repository's main checkout (whatever worktree is active), plus the active worktree.
pub(crate) fn main_repo(state: &State<'_, AppState>, id: &str) -> Result<(Git, Option<PathBuf>)> {
    let config = state.config.lock().unwrap();
    let r = config.find(id).ok_or_else(|| AppError::msg("That repository is no longer in Melodic Studio"))?;
    Ok((Git::at(&r.path), r.worktree.clone().filter(|w| w.is_dir())))
}

pub(crate) fn save_worktree(state: &State<'_, AppState>, id: &str, worktree: Option<PathBuf>) -> Result<()> {
    let mut config = state.config.lock().unwrap();
    let r = config.repos.iter_mut().find(|r| r.id == id).ok_or_else(|| AppError::msg("That repository is no longer in Melodic Studio"))?;
    r.worktree = worktree;
    config.save(&state.config_path)
}

pub(crate) fn register(state: &State<'_, AppState>, path: &Path) -> Result<RepoSummary> {
    let id = path.to_string_lossy().to_string();
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| id.clone());
    let mut config = state.config.lock().unwrap();
    if config.find(&id).is_none() {
        config.repos.push(RepoRef { id: id.clone(), name, path: path.to_path_buf(), worktree: None });
        config.repos.sort_by_key(|r| r.name.to_lowercase());
    }
    config.current = Some(id.clone());
    config.save(&state.config_path)?;
    Ok(summary(config.find(&id).unwrap()))
}

/// Quit and start again, after an update has been installed. See `proc::relaunch`.
#[tauri::command]
pub async fn app_relaunch(app: tauri::AppHandle) -> Result<()> {
    if crate::proc::relaunch().is_ok() {
        // `exit` rather than `std::process::exit`, so RunEvent::Exit still stops what we started.
        app.exit(0);
        return Ok(());
    }
    app.restart()
}

#[tauri::command]
pub async fn app_status(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<AppStatus> {
    let (repos, current) = {
        let config = state.config.lock().unwrap();
        (config.repos.iter().map(summary).collect(), config.current.clone())
    };
    Ok(AppStatus {
        repos,
        current,
        git_version: Git::version(),
        author_name: Git::global_config("user.name"),
        author_email: Git::global_config("user.email"),
        app_version: app.package_info().version.to_string(),
    })
}

// ---- repositories -----------------------------------------------------------

#[tauri::command]
pub async fn repo_add(state: State<'_, AppState>, path: String) -> Result<RepoSummary> {
    let top = Git::toplevel(&crate::paths::typed(&path))?;
    register(&state, &top)
}

#[tauri::command]
pub async fn repo_create(state: State<'_, AppState>, parent: String, name: String, readme: bool) -> Result<RepoSummary> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(AppError::msg("Give the repository a simple folder name"));
    }
    let dir = crate::paths::typed(&parent).join(name);
    if dir.join(".git").exists() {
        return Err(AppError::msg("A repository already exists there. Use Add existing instead."));
    }
    let g = Git::init(&dir)?;
    if readme && !dir.join("README.md").exists() {
        std::fs::write(dir.join("README.md"), format!("# {name}\n"))?;
        // Best effort: without a configured identity the file is simply left as a first change.
        let _ = g.commit(&["README.md".into()], "Initial commit", "", false);
    }
    let top = Git::toplevel(&dir)?;
    register(&state, &top)
}

#[tauri::command]
pub async fn repo_clone(state: State<'_, AppState>, url: String, parent: String) -> Result<RepoSummary> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::msg("Enter a repository URL"));
    }
    let dest = crate::paths::typed(&parent).join(git::repo_name(url));
    if dest.exists() {
        return Err(AppError::msg(format!("{} already exists", dest.display())));
    }
    Git::clone(url, &dest)?;
    let top = Git::toplevel(&dest)?;
    register(&state, &top)
}

#[tauri::command]
pub async fn repo_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    let mut config = state.config.lock().unwrap();
    config.repos.retain(|r| r.id != id);
    if config.current.as_deref() == Some(id.as_str()) {
        config.current = config.repos.first().map(|r| r.id.clone());
    }
    config.save(&state.config_path)
}

#[tauri::command]
pub async fn repo_select(state: State<'_, AppState>, id: String) -> Result<()> {
    let mut config = state.config.lock().unwrap();
    if config.find(&id).is_none() {
        return Err(AppError::msg("That repository is no longer in Melodic Studio"));
    }
    config.current = Some(id);
    config.save(&state.config_path)
}

// ---- changes ----------------------------------------------------------------

#[tauri::command]
pub async fn repo_status(state: State<'_, AppState>, id: String) -> Result<RepoStatus> {
    repo(&state, &id)?.status()
}

#[tauri::command]
pub async fn file_diff(state: State<'_, AppState>, id: String, path: String, old_path: Option<String>, status: String) -> Result<DiffResult> {
    repo(&state, &id)?.diff_worktree(&path, old_path.as_deref(), &status)
}

#[tauri::command]
pub async fn commit_changes(state: State<'_, AppState>, id: String, paths: Vec<String>, summary: String, description: String, amend: bool) -> Result<()> {
    repo(&state, &id)?.commit(&paths, &summary, &description, amend)
}

#[tauri::command]
pub async fn resolve_file(state: State<'_, AppState>, id: String, path: String, side: String) -> Result<()> {
    repo(&state, &id)?.resolve(&path, &side)
}

#[tauri::command]
pub async fn ignore_file(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    repo(&state, &id)?.ignore(&path)
}

#[tauri::command]
pub async fn stash_save(state: State<'_, AppState>, id: String, message: String) -> Result<()> {
    repo(&state, &id)?.stash_save(&message)
}

#[tauri::command]
pub async fn stash_pop(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    repo(&state, &id)?.stash_pop(&name)
}

#[tauri::command]
pub async fn stash_drop(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    repo(&state, &id)?.stash_drop(&name)
}

#[tauri::command]
pub async fn op_continue(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.op_continue()
}

#[tauri::command]
pub async fn op_abort(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.op_abort()
}

#[tauri::command]
pub async fn revert_commit(state: State<'_, AppState>, id: String, hash: String) -> Result<()> {
    repo(&state, &id)?.revert(&hash)
}

#[tauri::command]
pub async fn cherry_pick(state: State<'_, AppState>, id: String, hashes: Vec<String>) -> Result<()> {
    repo(&state, &id)?.cherry_pick(&hashes)
}

#[tauri::command]
pub async fn rebase_plan(state: State<'_, AppState>, id: String, upstream: Option<String>) -> Result<Vec<Commit>> {
    repo(&state, &id)?.rebase_plan(upstream.as_deref())
}

#[tauri::command]
pub async fn rebase_interactive(state: State<'_, AppState>, id: String, upstream: Option<String>, steps: Vec<RebaseStep>) -> Result<()> {
    repo(&state, &id)?.rebase_interactive(upstream.as_deref(), &steps)
}

#[tauri::command]
pub async fn reset_to(state: State<'_, AppState>, id: String, hash: String, mode: String) -> Result<()> {
    repo(&state, &id)?.reset(&hash, &mode)
}

#[tauri::command]
pub async fn checkout_commit(state: State<'_, AppState>, id: String, hash: String) -> Result<()> {
    repo(&state, &id)?.checkout_commit(&hash)
}

#[tauri::command]
pub async fn tag_create(state: State<'_, AppState>, id: String, name: String, hash: String, push: bool) -> Result<()> {
    repo(&state, &id)?.tag_create(name.trim(), &hash, push)
}

#[tauri::command]
pub async fn tag_delete(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    repo(&state, &id)?.tag_delete(&name)
}

#[tauri::command]
pub async fn rebase_onto(state: State<'_, AppState>, id: String, onto: String) -> Result<()> {
    repo(&state, &id)?.rebase(&onto)
}

#[tauri::command]
pub async fn branch_delete_remote(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    repo(&state, &id)?.branch_delete_remote(&name)
}

#[tauri::command]
pub async fn discard_changes(state: State<'_, AppState>, id: String, files: Vec<FileRef>) -> Result<()> {
    repo(&state, &id)?.discard(&files)
}

#[tauri::command]
pub async fn undo_commit(state: State<'_, AppState>, id: String) -> Result<UndoneCommit> {
    repo(&state, &id)?.undo_commit()
}

// ---- history ----------------------------------------------------------------

#[tauri::command]
pub async fn history(state: State<'_, AppState>, id: String, skip: usize, limit: usize) -> Result<Vec<Commit>> {
    repo(&state, &id)?.log(skip, limit.clamp(1, 500))
}

#[tauri::command]
pub async fn compare_history(state: State<'_, AppState>, id: String, branch: String, ahead: bool, skip: usize, limit: usize) -> Result<Vec<Commit>> {
    repo(&state, &id)?.compare_log(&branch, ahead, skip, limit.clamp(1, 500))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCompare {
    pub name: String,
    pub ahead: u32,
    pub behind: u32,
}

/// Ahead/behind counts of the current branch against each of `branches` (at most 100; ones git cannot count are left out).
#[tauri::command]
pub async fn compare_counts(state: State<'_, AppState>, id: String, branches: Vec<String>) -> Result<Vec<BranchCompare>> {
    let g = repo(&state, &id)?;
    Ok(branches
        .into_iter()
        .take(100)
        .filter_map(|name| g.ahead_behind(&name).ok().map(|(ahead, behind)| BranchCompare { name, ahead, behind }))
        .collect())
}

#[tauri::command]
pub async fn commit_files(state: State<'_, AppState>, id: String, hash: String) -> Result<Vec<FileChange>> {
    repo(&state, &id)?.commit_files(&hash)
}

#[tauri::command]
pub async fn commit_diff(state: State<'_, AppState>, id: String, hash: String, path: String, old_path: Option<String>) -> Result<DiffResult> {
    repo(&state, &id)?.diff_commit(&hash, &path, old_path.as_deref())
}

// ---- branches ---------------------------------------------------------------

#[tauri::command]
pub async fn branches(state: State<'_, AppState>, id: String) -> Result<Vec<Branch>> {
    repo(&state, &id)?.branches()
}

#[tauri::command]
pub async fn branch_create(state: State<'_, AppState>, id: String, name: String, start: Option<String>) -> Result<()> {
    repo(&state, &id)?.branch_create(name.trim(), start.as_deref())
}

#[tauri::command]
pub async fn branch_checkout(state: State<'_, AppState>, id: String, name: String, is_remote: bool) -> Result<()> {
    repo(&state, &id)?.branch_checkout(&name, is_remote)
}

#[tauri::command]
pub async fn branch_delete(state: State<'_, AppState>, id: String, name: String, force: bool) -> Result<()> {
    repo(&state, &id)?.branch_delete(&name, force)
}

#[tauri::command]
pub async fn branch_rename(state: State<'_, AppState>, id: String, from: String, to: String) -> Result<()> {
    repo(&state, &id)?.branch_rename(&from, to.trim())
}

#[tauri::command]
pub async fn merge_branch(state: State<'_, AppState>, id: String, from: String) -> Result<String> {
    repo(&state, &id)?.merge(&from)
}

#[tauri::command]
pub async fn merge_squash(state: State<'_, AppState>, id: String, from: String, message: String) -> Result<()> {
    repo(&state, &id)?.merge_squash(&from, &message)
}

#[tauri::command]
pub async fn merge_abort(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.op_abort()
}

// ---- remotes ----------------------------------------------------------------

#[tauri::command]
pub async fn fetch(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.fetch()
}

#[tauri::command]
pub async fn pull(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.pull()
}

#[tauri::command]
pub async fn push(state: State<'_, AppState>, id: String, force: bool) -> Result<()> {
    repo(&state, &id)?.push(force)
}

#[tauri::command]
pub async fn remote_set(state: State<'_, AppState>, id: String, url: String) -> Result<()> {
    repo(&state, &id)?.set_remote(url.trim())
}

// ---- the world outside ------------------------------------------------------

/// Open the repository somewhere else: `finder`, `terminal`, or a page on its
/// host: `remote` (the repository), `issues`, `pulls`, `new-pull` (for the current branch)
/// or `commit` (with `arg` the hash).
#[tauri::command]
pub async fn open_in(app: tauri::AppHandle, state: State<'_, AppState>, id: String, target: String, arg: Option<String>) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let g = repo(&state, &id)?;
    let dir = g.dir.to_string_lossy().to_string();
    match target.as_str() {
        "finder" => app.opener().open_path(dir, None::<&str>).map_err(|e| AppError::msg(e.to_string())),
        "remote" | "issues" | "pulls" | "new-pull" | "commit" | "branch" => {
            let host = g.default_remote().and_then(|r| g.remote_url(&r)).and_then(|u| git::host(&u)).ok_or_else(|| AppError::msg("This repository has no web page to open"))?;
            let url = match target.as_str() {
                "remote" => Some(host.web.clone()),
                "issues" => host.issues.clone(),
                "pulls" => host.pulls.clone(),
                "new-pull" => {
                    let branch = g.run(&["symbolic-ref", "--short", "HEAD"]).map_err(|_| AppError::msg("Check out a branch first"))?;
                    host.new_pull(branch.trim())
                }
                "branch" => arg.as_deref().filter(|b| !b.is_empty()).and_then(|b| host.branch(b)),
                _ => arg.as_deref().filter(|h| h.chars().all(|c| c.is_ascii_hexdigit())).and_then(|h| host.commit(h)),
            }
            .ok_or_else(|| AppError::msg(format!("Melodic Studio does not know that page on {}", host.name)))?;
            app.opener().open_url(url, None::<&str>).map_err(|e| AppError::msg(e.to_string()))
        }
        "terminal" => crate::proc::open_terminal(&dir),
        _ => Err(AppError::msg("Unknown target")),
    }
}

// ---- who commits ------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identities {
    pub global: Identity,
    /// The repository's own identity, when it overrides the global one.
    pub repo: Option<Identity>,
}

/// The global identity, plus repository `id`'s override when one is given.
#[tauri::command]
pub async fn identity_get(state: State<'_, AppState>, id: Option<String>) -> Result<Identities> {
    let repo = match id {
        Some(id) => main_repo(&state, &id)?.0.local_identity(),
        None => None,
    };
    Ok(Identities { global: Git::global_identity(), repo })
}

/// Without `id`, set the global identity (`identity` required). With `id`, set that
/// repository's override, or remove it with `identity: null`.
#[tauri::command]
pub async fn identity_set(state: State<'_, AppState>, id: Option<String>, identity: Option<Identity>) -> Result<()> {
    match id {
        Some(id) => main_repo(&state, &id)?.0.set_local_identity(identity.as_ref()),
        None => Git::set_global_identity(&identity.ok_or_else(|| AppError::msg("Give both a name and an email"))?),
    }
}

// ---- files (the Files tab) ---------------------------------------------------

#[tauri::command]
pub async fn list_dir(state: State<'_, AppState>, id: String, path: String) -> Result<Vec<crate::files::TreeEntry>> {
    crate::files::list_dir(&repo(&state, &id)?, &path)
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, id: String, path: String) -> Result<crate::files::FileContent> {
    crate::files::read_file(&repo(&state, &id)?, &path)
}

#[tauri::command]
pub async fn write_file(state: State<'_, AppState>, id: String, path: String, text: String, root: String) -> Result<()> {
    let g = repo(&state, &id)?;
    // The editor says which checkout it read the file from. If the active worktree changed
    // since, the same relative path now names a different file: refuse rather than overwrite it.
    if !crate::files::same_dir(&g.dir, Path::new(&root)) {
        return Err(AppError::msg("The active checkout changed, so nothing was saved. Open the file again and retry."));
    }
    crate::files::write_file(&g, &path, &text)
}

#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    Ok(app.dialog().file().blocking_pick_folder().map(|p| p.to_string()))
}
