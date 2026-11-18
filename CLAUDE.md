# Melodic Studio

Cross-platform desktop developer workspace: a git client in the spirit of GitHub Desktop, a read-mostly code viewer, and AI agents that each work in their own git worktree. Tauri 2 + Melodic JS/Components 4. Started 2026-11-16 as "Repoman" (the folder still carries that name; components are `ms-*`, app tokens `--ms-*`). Layout and conventions follow `../chamber`.

## Layout

```
src-tauri/src/
  git.rs        thin wrapper over the system git (never libgit2, nothing bundled): status, diff, commit, stash,
                branches, merge/rebase/revert/reset, tags, fetch/pull/push; host() recognises GitHub, Azure DevOps,
                GitLab, Bitbucket from the remote URL. Tests run real git in temp repos.
  commands.rs   Tauri commands (thin, all async, camelCase DTOs). Only repositories in the config can be operated on.
  config.rs     registry of added repositories (app config dir, repositories.json)
  error.rs      AppError -> {kind, message, paths}; kind: conflict | auth | git | error
  init.rs       turning a plain folder into a repository: inspect it, then git init with the wizard's choices
                (default branch, .gitignore templates, README, first commit, per-repository identity)
  dev.rs        debug builds only: STUDIO_DEV_EVAL runs a script file in the window, dev_log sends lines back;
                `server` starts Vite when a dev build is opened without it (cfg(dev)) and stops it on exit
  paths.rs      how absolute paths are spelled and compared (native / same / typed), and the PATH fix for
                GUI-launched apps so git, ssh and claude resolve
  proc.rs       the only way to start a process (command), stop one (kill_tree), or hand off to the user's
                terminal (open_terminal)
  worktree.rs   git worktrees (`<repo>.worktrees/<branch>` beside the repository) + the "active checkout" commands
  agent.rs      agent sessions: runs the user's `claude` CLI headless in a checkout, streams its stream-json events
  lsp.rs        starts an installed language server in the active checkout and relays its JSON-RPC messages
  host_cli.rs   the host through the user's own gh / az (+ azure-devops extension) / glab: tool status, issues and work
                items, pull request context/create, new remote repositories. Every call has a timeout. Tests parse
                captured CLI output; `cargo test live_read_only -- --ignored` runs read-only calls against the real tools.
  host_ops.rs   pull requests (list, view, review, comment, merge, fetch for a worktree), issue actions (create, comment,
                close/reopen), CI runs (+ re-run) and Jira through acli; same rules as host_cli.rs, whose helpers it uses
  templates.rs  File > New Project: the template catalog (data), the argv steps per template, a streamed, stoppable run
  menu.rs       the OS menu bar; our items reach the page as `menu` events (MenuService)
  ai_git.rs     git for the AI features around changes (`ai_*` commands): capped diffs for prompts (checked files, one
                commit, what a push would send), and the preview/apply of a proposed conflict resolution
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
  shared/paths.ts       the only place absolute paths are compared or taken apart (samePath, relativeTo, joinPath, fileName)
  shared/platform.ts    web view minimum check at startup; turns off the web view's reload keys and page menu in the packaged app
  services/agents.store.ts      agent sessions (persisted in localStorage), worktrees, review/merge/remove
  services/lsp.service.ts       LSP client; attaches itself to Monaco when the Files tab first opens
  services/lsp/protocol.ts      the Monaco-free half of the client (JSON-RPC, initialize, answer conversions); scripts/lsp-smoke.mjs runs it in Node against real servers
  services/language-servers.store.ts + components/settings   the "Language servers" section of Settings: status, Install, Remove, Restart
  components/agents     sidebar "Agents" tab, the session transcript pane, the worktree banner, their dialogs
  services/ai-prompts.ts        every prompt of the AI change features, the parser for its answer, model and tools per feature
  services/ai-features.store.ts commit message, explain, review before push, conflict proposal: one stoppable run each, state as signals
  components/ai         ai-entry.ts (the hooks app/changes/history call), side panel (explanation, review findings), review
                        diff and proposal panes for the main pane, commit-form sparkle, review strip, markdown renderer
                        agent-board (toolbar button + board of every session in every repository), ask (new-question pane,
                        ms-ask-button for other tabs), attempts (side-by-side compare of parallel attempts),
                        rich-text.ts (Markdown -> templates, with file/commit/url links), agent-state.ts (status pill)
  services/agent-paths.ts       the only path handling the agent features do (samePath, repoRelative); adjust here
  components/repo-tabs  the tab strip across the top: several repositories open side by side (hidden with one)
  components/init       setup wizard for a folder that is not a repository yet + InitService.open(path), the one way to open a folder
  services/ai.service.ts        AiService.ask(): one-shot questions to the user's `claude` CLI (no MCP servers or skills, named tools only)
  dev/hooks.ts          dev builds only: window.__studio (stores, q() through shadow roots, log()) for scripts run via STUDIO_DEV_EVAL
  components/dialogs    every ml-dialog, opened by id through RepoStore.ask(name, prompt); git-ops.* holds the merge
                        (merge / squash / rebase), cherry-pick and interactive-rebase dialogs
  services/host-work.store.ts   pull requests browser, issue actions, CI runs, Jira, tool notices (HostWorkStore)
  components/host/host-work, cli-notice, ci-status   the Pull requests / Jira dialogs, "install the CLI" notices, toolbar CI icon
  components/settings/accounts, editor-settings     Settings tabs; services/editor-settings.store.ts (font, zoom, saving)
  components/new-project        File > New Project dialog, then InitService.open(path, true)
  services/host.store.ts        issues list, "start agent on this", the pull request draft; opens the two dialogs below
  components/host       Issues / work items dialog and the Create pull request dialog (HostStore.openIssues() / openPr())
  services/demo-host.ts         demo issues, pull request and host tools for the browser preview (?host=missing|signed-out)
  styles/global.css     theme: --ml-* overrides + --ms-* tokens, light on :root, dark on :root[data-theme='dark']
```

## Decisions (do not regress)

- All git work shells out to the user's `git`, so SSH agent, credential helpers, hooks and signing just work. No stored tokens, and the app itself calls no host API. Web links (issues, pull requests, commits) are built from the remote URL and opened in the browser.
- Host data (issues, work items, pull requests, new repositories) comes only through the command-line tool the user has signed in to: `gh`, `az` with the azure-devops extension, `glab` (`host_cli.rs`). When the tool is missing or signed out the UI says exactly what to install or run and falls back to the web page. Arguments are separate argv entries in `--flag=value` form (never a shell line); long text goes on stdin (`gh --body-file=-`) or through a temp file (`az --flag=@file`, which also keeps `az.cmd` quoting out of it); names starting with `-` or `@` are refused. Nothing is installed for the user (`AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no`).
- Text from the host (issue bodies, titles, labels) is untrusted: shown as plain text only (work item HTML is reduced to text in Rust), never as HTML. In an agent's task it is fenced and labelled as a description, and the user edits the task before starting.
- Publishing happens only on an explicit click: `pr_create` from the Create button of the pull request dialog (which refuses until the branch is fully pushed), `host_repo_create` from the new-repository flow; reviews, comments, merges, new issues, issue state changes, CI re-runs and Jira moves (`host_ops.rs`) each from their own button. Never as a side effect of anything else. Jira goes through Atlassian's `acli` only (no token kept); its site and project per repository are in localStorage `studio.jira`. `host_open` opens only https pages on the repository's own host.
- `GIT_LITERAL_PATHSPECS=1` on every call so file names are never read as globs. `git stash` breaks under it; those calls use `run_magic`.
- Commit model is GitHub Desktop's: the checked files are the commit. `commit()` resets the index (except mid-merge), adds exactly the selected paths via `--pathspec-from-file`, then commits.
- History operations (`git.rs`, `ms-git-ops`): cherry-pick takes several commits, oldest first, in one `git cherry-pick`. Squash merge is `merge --squash` then a commit with the dialog's message on stdin; on conflicts the message is written to SQUASH_MSG and the operation shows as `squash` (only while files are conflicted: SQUASH_MSG outlives a squash finished in a terminal), Continue commits from it, Abort is `reset --merge`. Interactive rebase is git's own `rebase -i --autostash` with `GIT_SEQUENCE_EDITOR` set to `cp '<our todo file>'` (git starts the editor through its shell; Git for Windows brings one); the todo and new messages live in `<git dir>/studio-rebase/`, and a new message is an `exec git commit --amend --no-verify -F <file>` after the commit's last squash/fixup, so a stop for conflicts in between keeps it. The list sent must be exactly the commits of `upstream..HEAD` (re-read in Rust), merges in the range are refused, and the first kept line cannot be squash/fixup. Rows are reordered with pointer events, not HTML drag and drop (the window's file-drop handling).
- Undo/amend are only offered while the tip commit is on no remote. Force push is `--force-with-lease`, offered only after a rejected push.
- Commit identity is git's own config, nothing stored by us: Settings edits `--global` user.name/email, and "Use a different name and email in <repo>" writes `--local` (the main checkout's `.git/config`, so its worktrees and agents share it); unticking unsets it. `identity_get` / `identity_set` in commands.rs. There is no external-editor setting: editing happens in the Files tab.
- Files tab operations (`files.rs` create / relocate / duplicate / trash / import / locate): every path through
  `resolve()` (folders) or `entry()` (the entry itself, so a symlink is moved, never its target); never replaces without
  `OnConflict` saying so; trash, with deleting only for files where there is no trash. Drops from outside use Tauri's
  `onDragDropEvent` (positions / devicePixelRatio, which includes the webview zoom); moves inside the tree use pointer events.
- Discard restores tracked files from HEAD and moves untracked ones to the OS trash.
- Branch/ref/hash arguments go through `check_ref` (nothing starting with `-`).
- Files tab (`files.rs`): paths are repo-relative and resolved through `resolve()`, which refuses absolute paths, `..`, `.git` and symlinks leading out. Saving never creates a file, and a file that changed on disk since it was read is not overwritten without asking. `Git::ignored` drops `GIT_LITERAL_PATHSPECS` because `check-ignore` rejects it.
- Monaco is imported only through `shared/monaco.ts` (dynamic import, so startup does not pay for it). Worker imports use the package's export paths (`monaco-editor/editor/editor.worker.js?worker`), not `esm/vs/...`.
- Status is polled every 5 s while visible and on window focus; `GIT_OPTIONAL_LOCKS=0` keeps that from fighting a terminal.

- Worktrees: `RepoRef.worktree` is the active checkout. `commands::repo()` resolves every command to it, so Changes, History, Files and language servers follow a worktree switch with no per-command work; `main_repo()` is for the few commands that must act on the main checkout. The frontend calls `RepoStore.switchContext()` after any switch.
- Agents are Claude Code, not a reimplementation: `claude -p --output-format stream-json --verbose --permission-mode <mode> [--resume <id>]`, prompt on stdin (never argv), cwd checked against the repository's worktrees. Only assistant/user/result/init events are forwarded. `claude -p` counts as the SDK, which hides the Artifact tool, so `agent::claude()` sets `CLAUDE_CODE_ARTIFACT=1` unless the user set it (their `enableArtifact: false` still wins). `total_cost_usd` is the session's running total. Agents do not commit; the user reviews in the Changes tab of the agent's worktree, commits, then merges. The Merge… dialog (agent-session.component.ts) lets the user pick the target: any local branch (merged where it is checked out: its worktree, else the main checkout switches to it first and must be clean) or a new branch made from one; or, for protected branches, "Open a pull request" switches to the agent's worktree and opens the normal PR dialog. `AgentsStore.merge(session, into, from)`.
- Agent sessions have a `kind`. `task` is the above. `ask` is a read-only chat (Ask the repository, History questions): it runs in the active checkout, never a new worktree, in `default` permission mode with `RunOptions { tools, builtin, lean }`. `tools` (`ASK_TOOLS` in agents.store.ts) is the allow-list, `builtin` (`--tools`) limits the tools Claude can even see to the names in it, so the user's own settings cannot widen it; `lean` skips MCP servers and skills but keeps the session, so follow-ups `--resume`. History questions add `Bash(git log:*)`, `git show`, `git diff`, `git blame`. The first prompt (`askPrompt`) carries the rules; run against the real CLI it had to say "one plain git command, no `cd`, no `git -C`, no pipes", because those forms do not match the rules and are refused.
- Agent text is never HTML. `rich-text.ts` parses the Markdown itself and renders through templates; the only links are made there: `path:line` (opens the Files tab at the line via `ExplorerStore.openAt`), commit hashes in history sessions (selects the commit, loading more history until it is found) and http(s) addresses (opener plugin). File detection is strict on purpose (`fileRef`): a link that opens nothing is worse than none.
- Parallel attempts are ordinary task sessions sharing a `group`, on `branch`, `branch-2`, `branch-3`. Each records `base`, the commit its worktree started at; `worktree_diff` compares the checkout with it (commits since, uncommitted and untracked work) without touching the index or the files. "Keep this one" deletes the other attempts' worktrees and branches.
- The agents store listens for events from app start (the toolbar's `ms-agent-board` calls `init()`), not from the first visit to the Agents tab, so sessions in other repositories and ones started from elsewhere (`AgentsStore.start`) stay right. A turn that ends while not on screen sets `unread` (badge on the toolbar button) and shows a toast. Every store action is a plain awaitable method; `idle(id)` resolves when a session's turn has ended.
- Language servers are whatever the user has installed (a project's `node_modules/.bin` first, then PATH); nothing is bundled or downloaded. The protocol is spoken in `lsp.service.ts`; the Rust side only frames messages. The editor component knows nothing about it.
- AI features around changes are one-shot `AiService.ask()` calls and never change the repository by themselves. What they send is bounded: `ai_git.rs` caps a diff at ~60 KB, giving every file an equal share (small files stay whole) and writing a note where something was cut. Prompts declare repository content to be data. Answers reach the page through text bindings only (`components/ai/markdown.ts`); never `unsafeHTML`.
- Commit message (haiku, no tools): text the user typed is never replaced; the answer is then offered as a suggestion to take or dismiss.
- Review before push covers merge-base(upstream, HEAD)..HEAD, or the merge-base with the default branch when the branch has no upstream. The diff in the prompt has new-file line numbers written in (`numbered()`), so findings name real lines; `ms-diff` shows them in place through `.notes` (keyed by new-file line). Sonnet, read-only tools (`Read`, `Grep`, `Glob`).
- Conflict proposals: Claude answers one replacement per conflict block and the frontend splices them into the file, so nothing outside a block can change (and a long file costs no more than its conflicts). The proposal is previewed with `git diff --no-index` against a temp file. Accepting goes through `files::resolve()` and is refused when markers remain, the file is no longer conflicted, it changed since it was read, or the active checkout switched; then it is `git add`ed.
- Two Melodic traps: a component that first renders an empty template (``html`` ``) never shows a later non-empty one, so render `nothing()` (ai-entry.ts) instead; and `computed()` created while a component renders is disposed with that component, so a store with computed fields is instantiated at module load (end of ai-features.store.ts) and its effects are created outside any component.

- Repository tabs (`RepoStore.repoTabs`, localStorage `studio.repo-tabs`): `selectRepo(id)` switches in the current tab, `selectRepo(id, true)` / `openRepoTab` opens another. Each tab's view (sidebar tab, selected file, pinned diff tabs, unchecked files, draft message) is kept in memory by `keepView`/`restoreView`. The strip, not the toolbar, takes the macOS traffic-light padding while it is visible.
- Opening a folder always goes through `InitService.open(path)`: a repository is added, anything else starts the setup wizard. The wizard never overwrites: .gitignore is appended to, an existing README is kept, and a folder inside another repository is refused. Creating the remote uses `host_repo_create` (the user's gh / az / glab), then the normal publish.
- macOS dev builds run from `target/debug/Melodic Studio.app` (cargo runner `scripts/dev-app.sh`, set in `src-tauri/.cargo/config.toml`), because a bare binary shows in the Dock under its file name. The runner passes everything except the app binary straight through, so `cargo test` is unaffected.
- A dev build (`cfg(dev)`) has no pages of its own, only `build.devUrl`. Opened without `npm run desktop:dev` (that bundle's Dock icon, Finder, `cargo run`) it used to be a white window; now `dev.rs` checks the address at startup and, when nothing answers, runs `node node_modules/vite/bin/vite.js` in the project (found through `CARGO_MANIFEST_DIR`), shows a plain page meanwhile or the reason it failed, and navigates to the app once the port answers. Vite is stopped on `RunEvent::Exit`, not a window event: quitting from the Dock or with Cmd+Q sends no `Destroyed`. Release builds contain none of this.
- A component's first render must not be a bare ``html`` `` if it will ever show something else (Melodic never leaves an empty first template): render a hidden placeholder, or `nothing()` from `components/ai/ai-entry.ts`.

- `[profile.release.build-override] strip = false` in Cargo.toml is load-bearing: with a macOS deployment target of 13+ (ours is 14) recent Xcode's `strip` corrupts proc-macro libraries and the release build fails with "mis-aligned LINKEDIT string pool".

## Claude workspace

```
src-tauri/src/conversation.rs      claude_open: the user's `claude` CLI, interactive, on a pty (terminal::start, so term_* work on it);
                                   its hooks post to a 127.0.0.1 receiver here and arrive as `claude-hook` events
src-tauri/src/sessions.rs          claude_sessions: Claude Code sessions started outside the app, read from ~/.claude/projects transcripts
src/services/screens.ts            ScreenPool: every xterm screen (bottom panel and workspace), started once it has a size
src/services/workspace.store.ts    conversations + shells, the split layout per repository, hook-driven state, saved conversations
src/components/workspace           ms-workspace (bar, split tree, overview), ms-ws-pane (tabs, drag to move/split), toolbar button
```

- A conversation is Claude Code itself in a terminal, nothing reimplemented. Status comes from HTTP hooks passed with `--settings <file>` (one file per conversation in the app cache dir, deleted when it ends): `UserPromptSubmit` (working; the first prompt becomes the title), `PreToolUse`/`PostToolUse` on `Task|Agent` (subagents), `Notification` (needs you; `idle_prompt` ignored), `Stop` (ready, carries `last_assistant_message`). They are added to the user's own hooks. Hook URLs carry a secret and a tag of ours, mapped to the terminal key in Rust. `SessionStart` does not reach HTTP hooks (checked with 2.1.327); nothing depends on it.
- New conversations get `--session-id <uuid>` from the window; saved ones (localStorage `studio.conversations`, after a restart or a closed tab) continue with `--resume`, only on a click. Shells are not saved.
- The Agents board and the Agents tab list the workspace's Claude conversations next to the agents; clicking one is `WorkspaceStore.open`. They also list sessions started outside the app (a terminal, an editor), found by `sessions.rs` in `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<checkout path, non-alphanumerics as ->/*.jsonl` for the main checkout and every worktree (folder names over 200 characters are shortened by Claude Code, so they match on the prefix). Headless sessions (`entrypoint` `sdk-*`: our agents and one-shots) and ones with no typed prompt are skipped; transcripts are cached by (mtime, length). Nothing reports their state: "active" only means the transcript changed in the last 10 minutes. `WorkspaceStore.adopt` turns one into a saved conversation (`outside: true`), and only the Resume click runs `claude --resume`; the resume screen warns while it may still be open in a terminal.
- `CLAUDE_MARKERS` (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_CHILD_SESSION) are removed from every child: a dev build started from inside Claude Code would otherwise make `claude` think it is nested and save no transcript.
- Layout: a tree of splits (`row`/`column`, shares adding up to 1) and panes (tabs); one per repository (`studio.workspace.layouts`). Tabs move with pointer events (no HTML drag and drop): the centre of a pane adds to it, an edge splits it. View: hidden / side (beside the main pane, `studio.workspace.width`) / full; Cmd/Ctrl+Shift+K toggles, Cmd/Ctrl+\ splits.
- Screens move between shadow roots, so `ScreenPool.show` adopts xterm's CSS into each root it shows in (without it, xterm's measuring text shows as a line of `iiii7777wwww`).
- The bottom terminal panel is per repository too: `TerminalStore.all` holds every shell, `tabs`/`active` are the open repository's.

## Integrated terminal

```
src-tauri/src/terminal.rs          shells on a pseudo-terminal (portable-pty: Unix ptys, Windows ConPTY): term_open / term_write /
                                   term_resize / term_close, `term-data` and `term-exit` events
src/services/terminal.store.ts     the panel's shells (per repository; screens in ScreenPool), open/closed state and height (studio.terminal.*)
src/shared/xterm.ts                lazy xterm.js load, its CSS adopted into the shadow root, theme from --ml-*/--ms-* tokens
src/components/terminal            ms-terminal: the panel under the main pane (tabs, top edge to drag, Ctrl+` / Ctrl+Shift+`)
src/services/demo-terminal.ts      the pretend shell of the browser preview
```

- The shell is the user's own: `$SHELL -l` on Unix (a login shell, because a GUI-launched app has almost no environment), `pwsh.exe`, else `powershell.exe`, else `%COMSPEC%` on Windows. It starts in the active checkout (`commands::repo`), so a new terminal follows a worktree switch; terminals already open stay where they are.
- Output travels as base64 of the raw bytes (a read can end inside a UTF-8 character) and can arrive before `term_open` has returned the key, so the store holds early events until it knows the key. Keystrokes are sent one write at a time: async commands may otherwise overtake each other.
- The xterm `Terminal` objects live in `ScreenPool`, not in a component: the work area is rebuilt on a repository or worktree switch and the panel is hidden with `display: none`, and neither may cost a shell or its scrollback. `term.open()` runs only once its element is on screen (xterm measures glyphs).
- The end of a shell comes from a thread waiting on the child, not from the output stream: ConPTY never reports end of stream. Closing a terminal hangs up (SIGHUP) on Unix and terminates on Windows; dropping the pty takes the rest along, and the window's `Destroyed` event closes them all.
- Ctrl+` is Ctrl on every OS and is caught in the capture phase, or a focused terminal would send it to the shell. Off the Mac, copy and paste are Ctrl+Shift+C / Ctrl+Shift+V; Windows also gets Ctrl+V and Ctrl+C-with-a-selection.
- Language servers: a project's own copy (`node_modules/.bin`) first, then the app's managed copy, then PATH. Nothing is bundled; managed copies are installed on request (Settings) into the app's data dir (`app_data_dir()/language-servers`: `node/` is an npm prefix, `dotnet/` a tool path, `storage/` server caches), never globally. The protocol is spoken in `lsp.service.ts` + `lsp/protocol.ts`; the Rust side only frames messages. The editor component knows nothing about it.
- TypeScript's managed install is `typescript-language-server` + `typescript@6`, not `typescript` latest: TypeScript 7 (the native compiler) ships no `tsserver.js`, which that server drives. `lsp_start` hands the client `initializationOptions` (tsserver path: the project's if it has a `tsserver.js`, else the managed one; intelephense storage paths). `.tsx`/`.jsx` go to the server as `typescriptreact`/`javascriptreact`. npm servers are started as `node <script>`, not through the `.bin` shim (a `.cmd` on Windows, where killing it would leave the server running).
- A server process has a unique key (`program@root#n`). One that exits by itself, or refuses `initialize`, is reported once (`lsp-closed` carries its last error line; `LspService.failures`, a toast, the Settings row) and not started again until `LspService.refresh()` (Restart, or any install/removal). `lsp_servers` runs each found copy with its version flag, because a file on PATH can be a stand-in that does not run (rustup's `rust-analyzer` proxy).
- Monaco's own TypeScript/JavaScript hover, definition, references, outline and diagnostics are off while a TypeScript server answers for the checkout on screen, on otherwise (`setBuiltInTypeScript` in `shared/monaco.ts`). Monaco 0.57 reads `setModeConfiguration` only once, when the first TS/JS file opens, so those five are switched off there before any file is open and registered by us from Monaco's own adapter classes (`monaco-editor/languages/features/typescript/tsMode.js`, typed in `shared/monaco-ts-mode.d.ts`); check that import when upgrading Monaco.

## Conventions

- Melodic 3-file pattern for big components, single file for small ones. `@Service()` for DI, `@ml:click`/`@ml:input`/`@ml:change` for Melodic events, `@click` for native.
- Never import `@tauri-apps/*` at module top level; lazy-import inside `isDesktop()` checks.
- No hard-coded colors in component styles; use `--ml-*` or `--ms-*`.
- New backend command: add to `git.rs` (with a test), `commands.rs`, the handler list in `lib.rs`, `backend.service.ts` (plus a demo case), then a store action.
- AI one-shots: the pull request draft is `AiService.ask` with tag `[pull-request]`, no tools, input cut to size in Rust (`pr_changes`); it must answer `{"title","body"}` and falls back to a draft from the commit subjects when Claude is unavailable.
- Commits: author as Rick only. No AI attribution trailers.

## Platforms

macOS, Windows and Linux are all first-class. CI (`.github/workflows/ci.yml`) runs typecheck, `npm test`, the build, clippy and `cargo test` on all three; the Rust tests run the runner's real git. Releases: pushing a `v*` tag runs `.github/workflows/release.yml` (universal macOS, Windows, Linux installers on a draft GitHub release, published when all three finish; signing secrets optional, an unsigned release stays a draft). The updater public key is in `tauri.conf.json`, its private key at `~/.tauri/melodic-studio.key` (never in the repository; `TAURI_SIGNING_PRIVATE_KEY` secret). A local `tauri build` needs that key in the environment or `--config src-tauri/tauri.no-updater.conf.json`. `npm run bump -- set <version>` keeps the three version files in step; setup and checklist in `docs/release.md`. Windows signing is `scripts/sign-windows.mjs` via `bundle.windows.signCommand` (set `SKIP_WIN_SIGN=1` for a local Windows build). Only macOS has been run by hand so far (see the end of this section).

### Rules (check new code against these)

1. **Paths.** There are two kinds and they are never mixed.
   - *Repository-relative* paths (`src/app/main.ts`) are `/` separated on every OS, in both directions, exactly as git prints them. Splitting on `/` is fine. On the Rust side go through `files::resolve()` before touching disk.
   - *Absolute* paths (repository, worktree, language-server root, agent cwd) are spelled the platform's way: `C:\Users\me\repo` on Windows. Git prints `C:/Users/me/repo`, so everything git prints goes through `paths::native()` before it is stored or sent to the window (`Git::toplevel`, `worktree::entries`). A `PathBuf` built with `join()` from one of those is already native.
   - Absolute paths are never compared as strings. Rust: `paths::same(a, b)` (real-path comparison; covers `/` vs `\`, case, 8.3 short names, `/var` vs `/private/var`). TypeScript: `samePath`, `relativeTo`, `joinPath`, `fileName` from `shared/paths.ts`. No `startsWith(root + '/')`, no `split('/')`, no `` `${root}/${rel}` `` on an absolute path. Monaco's `uri.fsPath` comes back as `c:\...` (lower-case drive) on Windows, which is why.
   - `worktree_add` returns the exact string `worktree_list` reports, so the stores may match `w.path === session.cwd`. Keep it that way if either changes.
   - Paths a person typed go through `paths::typed()` (quotes from Explorer's "Copy as path", `~`).
2. **Processes.** Every process starts from `proc::command()`: it resolves bare names on PATH with PATHEXT (`claude`, `code`, `typescript-language-server` are `.cmd` shims on Windows; the extension-less file beside them is a shell script Windows cannot run) and sets `CREATE_NO_WINDOW` so no console flashes. Then:
   - Stop a child with `proc::kill_tree()`, not `child.kill()`: a `.cmd` shim is `cmd.exe` -> `node.exe`, and killing `cmd.exe` leaves node running.
   - Free-form text (a prompt, a commit message for a tool other than git) goes in on stdin, never argv: Rust refuses `.cmd` arguments that contain a line break.
   - Feed stdin from another thread while reading stdout (`git::exec` does); writing it all first deadlocks once both pipes fill, at 4 KB on Windows.
   - No shell: no `sh -c`, no `true`, `/dev/null`, `$HOME` or `&&` in a command. (`git diff --no-index -- /dev/null <path>` is fine: git itself special-cases that literal name on Windows. `GIT_EDITOR` is `:`, which git treats as "no editor" without starting anything.)
   - Something the user carries on with (editor, terminal) goes through `proc::launch()` so it is detached and reaped.
3. **Line endings.** `.gitattributes` forces LF in every checkout. Never assume the user's files are LF. Tests that compare file contents set `core.autocrlf false` in their scratch repository (Git for Windows defaults to converting).
4. **Tests.** Temp dirs are spelled differently from what git reports (`/var` vs `/private/var` on macOS, `RUNNER~1` vs `runneradmin` on Windows CI): assert with `paths::same` or `Path::ends_with`, not string equality. File names must be legal on Windows (none of `* ? " < > | :`). No Unix-only test without `#[cfg(unix)]`.
5. **Window and keys.** `titleBarStyle: Overlay` and `hiddenTitle` only exist on macOS; Windows and Linux get their normal title bar, so the toolbar reserves traffic-light room and handles dragging only when `isDesktop() && isMac()`. Shortcuts test `e.metaKey || e.ctrlKey` (Monaco: `KeyMod.CtrlCmd`) and are shown with `isMac() ? '⌘' : 'Ctrl+'`. Platform checks are `isMac()` / `isWindows()` in `backend.service.ts`; nothing else reads `navigator.platform`.
6. **Web features.** The floor is Safari 17 / Chromium 114 / WebKitGTK 2.42 (table below). Anything newer needs a fallback or a line in that table. `main.ts` shows a plain message instead of the app when the web view is older.

### Per OS

- **macOS** (WKWebView): overlay title bar with the toolbar underneath. `paths::fix_path()` matters most here: Finder-launched apps get a bare PATH.
- **Windows** (WebView2): needs Git for Windows (MSYS or Cygwin git prints `/c/...` paths, which are not handled). `fix_path` only adds Git's and npm's install folders when PATH lacks them. "Open in terminal" tries Windows Terminal (`wt -d`), then `cmd`. `build.rs` embeds `windows-app-manifest.xml` in every executable, because the unit-test binary otherwise fails to start (`STATUS_ENTRYPOINT_NOT_FOUND`: tauri-build only gives the app binary the Common Controls 6 manifest). `files::resolve` also refuses the Windows aliases of `.git` (`.git.`, `.git::$INDEX_ALLOCATION`, `GIT~1`).
- **Linux** (WebKitGTK via `webkit2gtk-4.1`): the `.deb` and `.rpm` depend on `git`; an AppImage uses whatever git is installed. "Open in terminal" tries `$TERMINAL`, the desktop's own terminal, then a list (`proc::LINUX_TERMINALS`). "Show in file manager" needs `xdg-open`. Discard uses the FreeDesktop trash and falls back to deleting when there is none.
- **Both Unix**: PATH is the login shell's (`$SHELL -l -c`, 4 s limit), then the usual system folders, then tool-manager folders (snap, linuxbrew, volta, bun, asdf, mise, every nvm/fnm node version). The shell is not started interactive, so anything set up only in `.zshrc`/`.bashrc` is found through that last list or not at all.

### Minimum versions

| | Minimum | Why |
|---|---|---|
| macOS | 14 Sonoma (`bundle.macOS.minimumSystemVersion`) | WKWebView there is Safari 17: HTML Popover API (`ml-popover`, the toolbar menus). The ES2022 bundle alone needs Safari 16.4. |
| Windows | 10, with WebView2 Runtime 114+ (`bundle.windows.minimumWebview2Version`; evergreen, so normally current) | Popover API is Chromium 114. WebView2 no longer updates on Windows 7/8. |
| Linux | WebKitGTK 2.42+ as `webkit2gtk-4.1`: Ubuntu 22.04 with updates, Debian 12, Fedora 39 or later | Tauri 2 needs the 4.1 API; 2.42 is the WebKitGTK release matching Safari 17. |
| git | 2.28 | `init -b`; everything else used is older. |
| Node (development) | 22.18, CI uses `.nvmrc` | `npm test` runs TypeScript directly with Node's test runner. |

Also used and inside that floor: `crypto.randomUUID` (Safari 15.4, Chromium 92; needs a secure context, which `tauri://localhost` and `http://tauri.localhost` are), `navigator.clipboard.writeText` (called straight from a click, which WebKit requires), `Element.replaceChildren`, top-level `await`. `@starting-style` (Safari 17.5, Chromium 117) only animates popovers opening and degrades to no animation.

### Reasoned but never run

Nothing below has been executed on Windows or Linux; the first CI run and a manual pass on each are the proof. The Windows-only Rust in `proc.rs`, `paths.rs`, `git.rs` and `files.rs` was type-checked and linted for `x86_64-pc-windows-msvc`, and the Linux-only branches compiled with their `cfg` flipped, but not run.

- Windows: the whole app as a window; `build.rs` manifest embedding (and so whether `cargo test` starts at all); `.cmd` resolution for `claude`, `code` and language servers; `taskkill` tree kill; `wt`/`cmd` terminal launch; no console flashes; `/dev/null` diff of untracked files; the recycle bin; NSIS/MSI bundles and the WebView2 minimum check.
- Linux: the whole app as a window; terminal detection; `xdg-open`; trash; `.deb`/`.rpm` dependencies and the AppImage; WebKitGTK 2.42 actually having popovers on by default.
- Known gaps: repositories on UNC or `\\wsl$` paths (`cmd.exe` cannot use them as a working folder, so `.cmd` tools fail there); paths over 260 characters need `git config core.longpaths true`; removing a worktree fails on Windows while a language server or agent still has it as its working folder; whether macOS 12/13 with a Safari 17 update would work (the system WebKit is what counts, so the minimum is set to 14).

## Run

```sh
npm install
npm run desktop:dev     # Tauri window + Vite on :5190
npm run dev             # browser preview with demo data
npm run typecheck && npm test && (cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test)
npm run icon            # regenerate icons from icon-source.svg
(cd src-tauri && cargo test -- --ignored e2e)   # language servers end to end: installs the real ones into a temp dir (network, npm, dotnet), ~15 s when cached
```

## Status / next

Checked on macOS three ways: unit and integration tests (59 Rust tests against real git and ptys, 8 more ignored ones against real language servers and host CLIs, 5 TypeScript tests), the browser preview with the demo backend, and the real desktop window driven by script (`STUDIO_DEV_EVAL`, see `src-tauri/src/dev.rs`) with screenshots.

Run for real in the desktop window: add repository, status, diff, commit, push, history, branches, stash, worktrees, Files tab, the setup wizard through to a push, repository tabs, the terminal against a real shell, an agent session end to end (task, edit in its worktree, review, commit, merge, cleanup), one-shot AI (commit message, explain, review before push), Ask the repository, TypeScript hover and go-to-definition through the managed server, host tools (gh sign-in, owners, live issue list).

Not run for real: cherry-pick, squash merge and interactive rebase in the desktop window (Rust tests against real git, including conflicts mid-rebase, plus the browser preview), anything on Windows or Linux (written to the Platforms rules, linted for Windows in part; the first CI run is the proof), creating a pull request or a remote repository (unit tests and `gh --dry-run` only), Azure DevOps and GitLab beyond their signed-out / not-installed paths, parallel attempts and the agent board with real agents (preview only), conflict proposals in the window (Rust tests + preview + one real prompt), C# and PHP servers in the window (end-to-end tests only).

Not done: partial (line/hunk) commits, image diffs, dragging repository tabs to reorder, restoring the selected commit when returning to a tab, background auto-fetch, renaming the folder. In-app updates (`UpdatesService`, toolbar pill, Settings row; tauri-plugin-updater) are wired but have never been exercised: that needs two published releases. The release workflow itself has never run: the repository has no GitHub remote yet.
