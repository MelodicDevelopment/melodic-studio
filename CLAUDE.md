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
  lsp.rs        starts a language server in the active checkout and relays its JSON-RPC messages; lsp_servers / lsp_install / lsp_uninstall
  lsp/servers.rs  the servers we know (TypeScript/JavaScript, PHP, C#, Rust, Python, Go): lookup, "does it run" check, launch options, managed installs
  lsp/e2e.rs    ignored tests against the real servers, fixtures in tests/fixtures (cargo test -- --ignored e2e)
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
  services/lsp/protocol.ts      the Monaco-free half of the client (JSON-RPC, initialize, answer conversions); scripts/lsp-smoke.mjs runs it in Node against real servers
  services/language-servers.store.ts + components/settings   the "Language servers" section of Settings: status, Install, Remove, Restart
  components/agents     sidebar "Agents" tab, the session transcript pane, the worktree banner, their dialogs
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
- Language servers: a project's own copy (`node_modules/.bin`) first, then the app's managed copy, then PATH. Nothing is bundled; managed copies are installed on request (Settings) into the app's data dir (`app_data_dir()/language-servers`: `node/` is an npm prefix, `dotnet/` a tool path, `storage/` server caches), never globally. The protocol is spoken in `lsp.service.ts` + `lsp/protocol.ts`; the Rust side only frames messages. The editor component knows nothing about it.
- TypeScript's managed install is `typescript-language-server` + `typescript@6`, not `typescript` latest: TypeScript 7 (the native compiler) ships no `tsserver.js`, which that server drives. `lsp_start` hands the client `initializationOptions` (tsserver path: the project's if it has a `tsserver.js`, else the managed one; intelephense storage paths). `.tsx`/`.jsx` go to the server as `typescriptreact`/`javascriptreact`. npm servers are started as `node <script>`, not through the `.bin` shim (a `.cmd` on Windows, where killing it would leave the server running).
- A server process has a unique key (`program@root#n`). One that exits by itself, or refuses `initialize`, is reported once (`lsp-closed` carries its last error line; `LspService.failures`, a toast, the Settings row) and not started again until `LspService.refresh()` (Restart, or any install/removal). `lsp_servers` runs each found copy with its version flag, because a file on PATH can be a stand-in that does not run (rustup's `rust-analyzer` proxy).
- Monaco's own TypeScript/JavaScript hover, definition, references, outline and diagnostics are off while a TypeScript server answers for the checkout on screen, on otherwise (`setBuiltInTypeScript` in `shared/monaco.ts`). Monaco 0.57 reads `setModeConfiguration` only once, when the first TS/JS file opens, so those five are switched off there before any file is open and registered by us from Monaco's own adapter classes (`monaco-editor/languages/features/typescript/tsMode.js`, typed in `shared/monaco-ts-mode.d.ts`); check that import when upgrading Monaco.

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
(cd src-tauri && cargo test -- --ignored e2e)   # language servers end to end: installs the real ones into a temp dir (network, npm, dotnet), ~15 s when cached
```

## Status / next

Built and checked in the browser preview (demo backend) and by Rust tests against real git. Not yet run as a desktop window, so agent sessions and language servers have only been exercised piecewise: the `claude` CLI invocation and its event format by hand, LSP framing by unit test, the agent UI against demo events. Not done: integrated terminal, cherry-pick UI (backend command exists), partial (line/hunk) commits, image diffs, listing issues/work items inside the app (needs host API tokens), background auto-fetch, in-app updater, signing/release workflow, renaming the folder.

Language servers: install/removal, launch, and hover/definition/outline/diagnostics run end to end against the real typescript-language-server, intelephense and csharp-ls (ignored Rust tests, plus the frontend's protocol code run in Node), on macOS only. The Monaco wiring in `lsp.service.ts`, the built-in TypeScript switch and the Settings section are type-checked and built but have not been seen in a window; nothing has run on Windows or Linux.
