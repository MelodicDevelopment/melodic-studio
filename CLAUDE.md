# Melodic Studio

Cross-platform desktop developer workspace: a git client in the spirit of GitHub Desktop, a read-mostly code viewer, and AI agents that each work in their own git worktree. Tauri 2 + Melodic JS/Components 4. Started 2026-11-16 as "Repoman" (the folder still carries that name; components are `ms-*`, app tokens `--ms-*`). Layout and conventions follow `../chamber`.

## Layout

```
src-tauri/src/
  git.rs        thin wrapper over the system git (never libgit2, nothing bundled): status, diff, commit, stash,
                branches, merge/rebase/revert/reset, tags, fetch/pull/push; host() recognises GitHub, Azure DevOps,
                GitLab, Bitbucket from the remote URL. Tests run real git in temp repos.
  commands.rs   Tauri commands (thin, all async, camelCase DTOs). Only repositories in the config can be operated on.
  config.rs     registry of added repositories (app config dir, repositories.json) + editor command
  error.rs      AppError -> {kind, message, paths}; kind: conflict | auth | git | error
  paths.rs      PATH fix for GUI-launched apps so git and ssh resolve
  worktree.rs   git worktrees (`<repo>.worktrees/<branch>` beside the repository) + the "active checkout" commands
  agent.rs      agent sessions: runs the user's `claude` CLI headless in a checkout, streams its stream-json events
  lsp.rs        starts an installed language server in the active checkout and relays its JSON-RPC messages
src/
  services/backend.service.ts   the ONLY place that calls invoke(); in-memory demo backend for the browser preview
  services/repo.store.ts        all app state as signals + every action; components read signals in templates
  components/app        shell: sidebar tabs, resizer, diff pane with file tabs, commit detail, empty/welcome states
  components/toolbar    repository / branch dropdowns (ml-popover), sync button, host links
  components/changes    checked file list, context menu, stash, commit form, amend, undo
  components/history    commit list + commit context menu
  components/diff       unified diff renderer (shared/diff.ts parses)
  components/explorer   sidebar "Files" tab: lazy folder tree of the working tree, git status marks, ignored entries dimmed
  components/editor     main pane of the Files tab: open-file tabs over one Monaco editor, save (Cmd/Ctrl+S), unsaved/conflict bar
  services/explorer.store.ts    Files tab state per repository: tree, open tabs, Monaco models (they outlive the editor component)
  shared/monaco.ts      lazy Monaco load, workers, theme from --ml-*/--ms-* tokens, copies Monaco's CSS into the shadow root
  services/agents.store.ts      agent sessions (persisted in localStorage), worktrees, review/merge/remove
  services/lsp.service.ts       LSP client; attaches itself to Monaco when the Files tab first opens
  components/agents     sidebar "Agents" tab, the session transcript pane, the worktree banner, their dialogs
                        agent-board (toolbar button + board of every session in every repository), ask (new-question pane,
                        ms-ask-button for other tabs), attempts (side-by-side compare of parallel attempts),
                        rich-text.ts (Markdown -> templates, with file/commit/url links), agent-state.ts (status pill)
  services/agent-paths.ts       the only path handling the agent features do (samePath, repoRelative); adjust here
  components/dialogs    every ml-dialog, opened by id through RepoStore.ask(name, prompt)
  styles/global.css     theme: --ml-* overrides + --ms-* tokens, light on :root, dark on :root[data-theme='dark']
```

## Decisions (do not regress)

- All git work shells out to the user's `git`, so SSH agent, credential helpers, hooks and signing just work. No host API calls, no stored tokens. Web links (issues, pull requests, commits) are built from the remote URL and opened in the browser.
- `GIT_LITERAL_PATHSPECS=1` on every call so file names are never read as globs. `git stash` breaks under it; those calls use `run_magic`.
- Commit model is GitHub Desktop's: the checked files are the commit. `commit()` resets the index (except mid-merge), adds exactly the selected paths via `--pathspec-from-file`, then commits.
- Undo/amend are only offered while the tip commit is on no remote. Force push is `--force-with-lease`, offered only after a rejected push.
- Discard restores tracked files from HEAD and moves untracked ones to the OS trash.
- Branch/ref/hash arguments go through `check_ref` (nothing starting with `-`).
- Files tab (`files.rs`): paths are repo-relative and resolved through `resolve()`, which refuses absolute paths, `..`, `.git` and symlinks leading out. Saving never creates a file, and a file that changed on disk since it was read is not overwritten without asking. `Git::ignored` drops `GIT_LITERAL_PATHSPECS` because `check-ignore` rejects it.
- Monaco is imported only through `shared/monaco.ts` (dynamic import, so startup does not pay for it). Worker imports use the package's export paths (`monaco-editor/editor/editor.worker.js?worker`), not `esm/vs/...`.
- Status is polled every 5 s while visible and on window focus; `GIT_OPTIONAL_LOCKS=0` keeps that from fighting a terminal.

- Worktrees: `RepoRef.worktree` is the active checkout. `commands::repo()` resolves every command to it, so Changes, History, Files and language servers follow a worktree switch with no per-command work; `main_repo()` is for the few commands that must act on the main checkout. The frontend calls `RepoStore.switchContext()` after any switch.
- Agents are Claude Code, not a reimplementation: `claude -p --output-format stream-json --verbose --permission-mode <mode> [--resume <id>]`, prompt on stdin (never argv), cwd checked against the repository's worktrees. Only assistant/user/result/init events are forwarded. `total_cost_usd` is the session's running total. Agents do not commit; the user reviews in the Changes tab of the agent's worktree, commits, then merges.
- Agent sessions have a `kind`. `task` is the above. `ask` is a read-only chat (Ask the repository, History questions): it runs in the active checkout, never a new worktree, in `default` permission mode with `RunOptions { tools, builtin, lean }`. `tools` (`ASK_TOOLS` in agents.store.ts) is the allow-list, `builtin` (`--tools`) limits the tools Claude can even see to the names in it, so the user's own settings cannot widen it; `lean` skips MCP servers and skills but keeps the session, so follow-ups `--resume`. History questions add `Bash(git log:*)`, `git show`, `git diff`, `git blame`. The first prompt (`askPrompt`) carries the rules; run against the real CLI it had to say "one plain git command, no `cd`, no `git -C`, no pipes", because those forms do not match the rules and are refused.
- Agent text is never HTML. `rich-text.ts` parses the Markdown itself and renders through templates; the only links are made there: `path:line` (opens the Files tab at the line via `ExplorerStore.openAt`), commit hashes in history sessions (selects the commit, loading more history until it is found) and http(s) addresses (opener plugin). File detection is strict on purpose (`fileRef`): a link that opens nothing is worse than none.
- Parallel attempts are ordinary task sessions sharing a `group`, on `branch`, `branch-2`, `branch-3`. Each records `base`, the commit its worktree started at; `worktree_diff` compares the checkout with it (commits since, uncommitted and untracked work) without touching the index or the files. "Keep this one" deletes the other attempts' worktrees and branches.
- The agents store listens for events from app start (the toolbar's `ms-agent-board` calls `init()`), not from the first visit to the Agents tab, so sessions in other repositories and ones started from elsewhere (`AgentsStore.start`) stay right. A turn that ends while not on screen sets `unread` (badge on the toolbar button) and shows a toast. Every store action is a plain awaitable method; `idle(id)` resolves when a session's turn has ended.
- Language servers are whatever the user has installed (a project's `node_modules/.bin` first, then PATH); nothing is bundled or downloaded. The protocol is spoken in `lsp.service.ts`; the Rust side only frames messages. The editor component knows nothing about it.

## Conventions

- Melodic 3-file pattern for big components, single file for small ones. `@Service()` for DI, `@ml:click`/`@ml:input`/`@ml:change` for Melodic events, `@click` for native.
- Never import `@tauri-apps/*` at module top level; lazy-import inside `isDesktop()` checks.
- No hard-coded colors in component styles; use `--ml-*` or `--ms-*`.
- New backend command: add to `git.rs` (with a test), `commands.rs`, the handler list in `lib.rs`, `backend.service.ts` (plus a demo case), then a store action.
- Commits: author as Rick only. No AI attribution trailers.

## Run

```sh
npm install
npm run desktop:dev     # Tauri window + Vite on :5190
npm run dev             # browser preview with demo data
npm run typecheck && (cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test)
npm run icon            # regenerate icons from icon-source.svg
```

## Status / next

Agent board, Ask the repository, History questions and parallel attempts: clicked through in the browser preview (the demo backend answers questions with file and commit references and gives each attempt a different diff); `worktree_diff` and the `claude` command line by Rust tests; the read-only allow-list by four real `claude -p` runs in a scratch repository (git log/show/blame ran, an edit and `touch` were refused, `--resume` worked with the lean flags). Not yet exercised in the desktop window.

Built and checked in the browser preview (demo backend) and by Rust tests against real git. Not yet run as a desktop window, so agent sessions and language servers have only been exercised piecewise: the `claude` CLI invocation and its event format by hand, LSP framing by unit test, the agent UI against demo events. Not done: integrated terminal, cherry-pick UI (backend command exists), partial (line/hunk) commits, image diffs, listing issues/work items inside the app (needs host API tokens), background auto-fetch, in-app updater, signing/release workflow, renaming the folder.
