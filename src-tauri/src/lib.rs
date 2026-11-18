mod agent;
mod ai_git;
mod commands;
mod config;
mod conversation;
mod dev;
mod error;
mod files;
mod git;
mod init;
mod host_cli;
mod host_ops;
mod lsp;
mod menu;
mod paths;
mod proc;
mod scan;
mod sessions;
mod templates;
mod terminal;
mod worktree;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// A repository's origin and the `.git/config` modification time it was read at.
pub type OriginCache = std::collections::HashMap<PathBuf, (Option<std::time::SystemTime>, Option<git::Origin>)>;

pub struct AppState {
    pub config_path: PathBuf,
    pub config: Mutex<config::AppConfig>,
    /// Each repository's origin, kept until its `.git/config` changes (see `commands::origins`).
    pub origins: Mutex<OriginCache>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Started by `app_relaunch` only to wait for the old instance and reopen the app: no window, no setup.
    if proc::relaunch_helper() {
        return;
    }
    paths::fix_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .setup(|app| {
            // Debug builds can keep their settings somewhere else, so a test instance never touches the real ones.
            let config_dir = match std::env::var("STUDIO_CONFIG_DIR") {
                Ok(dir) if cfg!(debug_assertions) && !dir.is_empty() => PathBuf::from(dir),
                _ => app.path().app_config_dir()?,
            };
            std::fs::create_dir_all(&config_dir)?;
            let config_path = config_dir.join("repositories.json");
            let config = config::AppConfig::load(&config_path).unwrap_or_default();
            app.manage(AppState { config_path, config: Mutex::new(config), origins: Mutex::default() });
            app.manage(agent::Agents::default());
            app.manage(lsp::Lsp::default());
            dev::start(app.handle());
            app.manage(terminal::Terminals::default());
            app.manage(templates::Scaffolds::default());
            app.manage(conversation::Hooks::default());
            conversation::clean(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::app_relaunch,
            commands::repo_add,
            commands::repo_add_many,
            commands::repo_scan,
            commands::repo_create,
            commands::repo_clone,
            commands::repo_remove,
            commands::repo_select,
            commands::repo_status,
            commands::file_diff,
            commands::commit_changes,
            commands::discard_changes,
            commands::resolve_file,
            commands::ignore_file,
            commands::stash_save,
            commands::stash_pop,
            commands::stash_drop,
            commands::op_continue,
            commands::op_abort,
            commands::revert_commit,
            commands::cherry_pick,
            commands::reset_to,
            commands::checkout_commit,
            commands::tag_create,
            commands::tag_delete,
            commands::rebase_onto,
            commands::rebase_plan,
            commands::rebase_interactive,
            commands::branch_delete_remote,
            commands::undo_commit,
            commands::history,
            commands::compare_history,
            commands::compare_counts,
            commands::commit_files,
            commands::commit_diff,
            ai_git::ai_selected_diff,
            ai_git::ai_commit_patch,
            ai_git::ai_push_diff,
            ai_git::ai_range_file_diff,
            ai_git::ai_conflict_file,
            ai_git::ai_resolution_preview,
            ai_git::ai_resolution_apply,
            commands::branches,
            commands::branch_create,
            commands::branch_checkout,
            commands::branch_delete,
            commands::branch_rename,
            commands::merge_branch,
            commands::merge_squash,
            commands::merge_abort,
            commands::fetch,
            commands::pull,
            commands::push,
            commands::remote_set,
            commands::open_in,
            commands::identity_get,
            commands::identity_set,
            commands::pick_folder,
            worktree::worktree_list,
            worktree::worktree_add,
            worktree::worktree_select,
            worktree::worktree_remove,
            worktree::worktree_diff,
            agent::agent_available,
            agent::agent_start,
            agent::agent_stop,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            dev::dev_log,
            init::folder_inspect,
            init::repo_init,
            init::open_url,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            conversation::claude_open,
            sessions::claude_sessions,
            lsp::lsp_servers,
            lsp::lsp_install,
            lsp::lsp_uninstall,
            commands::list_dir,
            host_ops::pr_list,
            host_ops::pr_view,
            host_ops::pr_review,
            host_ops::pr_comment,
            host_ops::pr_merge,
            host_ops::pr_fetch,
            host_ops::issue_create,
            host_ops::issue_comment,
            host_ops::issue_set_state,
            host_ops::ci_runs,
            host_ops::ci_rerun,
            host_ops::jira_issues,
            host_ops::jira_transition,
            host_ops::jira_comment,
            templates::project_templates,
            templates::project_create,
            templates::project_stop,
            commands::files_create,
            commands::files_move,
            commands::files_duplicate,
            commands::files_trash,
            commands::files_import,
            commands::read_file,
            commands::write_file,
            host_cli::issues_status,
            host_cli::issues_list,
            host_cli::pr_context,
            host_cli::pr_changes,
            host_cli::pr_existing,
            host_cli::pr_create,
            host_cli::pr_web_url,
            host_cli::host_open,
            host_cli::host_clis,
            host_cli::host_owners,
            host_cli::host_repo_create,
        ])
        .on_window_event(terminal::on_window_event)
        .build(tauri::generate_context!())
        .expect("error while running Melodic Studio")
        .run(|app, event| {
            // Quitting (Cmd+Q, the Dock) ends the app without a window event, so this is the one place every exit passes.
            if matches!(event, tauri::RunEvent::Exit) {
                dev::stop(app);
            }
        });
}
