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
  host_cli.rs   the host through the user's own gh / az (+ azure-devops extension) / glab: tool status, issues and work
                items, pull request context/create, new remote repositories. Every call has a timeout. Tests parse
                captured CLI output; `cargo test live_read_only -- --ignored` runs read-only calls against the real tools.
  ai_git.rs     git for the AI features around changes (`ai_*` commands): capped diffs for prompts (checked files, one
                commit, what a push would send), and the preview/apply of a proposed conflict resolution
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
  services/ai-prompts.ts        every prompt of the AI change features, the parser for its answer, model and tools per feature
  services/ai-features.store.ts commit message, explain, review before push, conflict proposal: one stoppable run each, state as signals
  components/ai         ai-entry.ts (the hooks app/changes/history call), side panel (explanation, review findings), review
                        diff and proposal panes for the main pane, commit-form sparkle, review strip, markdown renderer
  components/dialogs    every ml-dialog, opened by id through RepoStore.ask(name, prompt)
  services/host.store.ts        issues list, "start agent on this", the pull request draft; opens the two dialogs below
  components/host       Issues / work items dialog and the Create pull request dialog (HostStore.openIssues() / openPr())
  services/demo-host.ts         demo issues, pull request and host tools for the browser preview (?host=missing|signed-out)
  styles/global.css     theme: --ml-* overrides + --ms-* tokens, light on :root, dark on :root[data-theme='dark']
```

## Decisions (do not regress)

- All git work shells out to the user's `git`, so SSH agent, credential helpers, hooks and signing just work. No stored tokens, and the app itself calls no host API. Web links (issues, pull requests, commits) are built from the remote URL and opened in the browser.
- Host data (issues, work items, pull requests, new repositories) comes only through the command-line tool the user has signed in to: `gh`, `az` with the azure-devops extension, `glab` (`host_cli.rs`). When the tool is missing or signed out the UI says exactly what to install or run and falls back to the web page. Arguments are separate argv entries in `--flag=value` form (never a shell line); long text goes on stdin (`gh --body-file=-`) or through a temp file (`az --flag=@file`, which also keeps `az.cmd` quoting out of it); names starting with `-` or `@` are refused. Nothing is installed for the user (`AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no`).
- Text from the host (issue bodies, titles, labels) is untrusted: shown as plain text only (work item HTML is reduced to text in Rust), never as HTML. In an agent's task it is fenced and labelled as a description, and the user edits the task before starting.
- Publishing happens only on an explicit click: `pr_create` from the Create button of the pull request dialog (which refuses until the branch is fully pushed), `host_repo_create` from the new-repository flow. Never as a side effect of anything else. `host_open` opens only https pages on the repository's own host.
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
- Language servers are whatever the user has installed (a project's `node_modules/.bin` first, then PATH); nothing is bundled or downloaded. The protocol is spoken in `lsp.service.ts`; the Rust side only frames messages. The editor component knows nothing about it.
- AI features around changes are one-shot `AiService.ask()` calls and never change the repository by themselves. What they send is bounded: `ai_git.rs` caps a diff at ~60 KB, giving every file an equal share (small files stay whole) and writing a note where something was cut. Prompts declare repository content to be data. Answers reach the page through text bindings only (`components/ai/markdown.ts`); never `unsafeHTML`.
- Commit message (haiku, no tools): text the user typed is never replaced; the answer is then offered as a suggestion to take or dismiss.
- Review before push covers merge-base(upstream, HEAD)..HEAD, or the merge-base with the default branch when the branch has no upstream. The diff in the prompt has new-file line numbers written in (`numbered()`), so findings name real lines; `ms-diff` shows them in place through `.notes` (keyed by new-file line). Sonnet, read-only tools (`Read`, `Grep`, `Glob`).
- Conflict proposals: Claude answers one replacement per conflict block and the frontend splices them into the file, so nothing outside a block can change (and a long file costs no more than its conflicts). The proposal is previewed with `git diff --no-index` against a temp file. Accepting goes through `files::resolve()` and is refused when markers remain, the file is no longer conflicted, it changed since it was read, or the active checkout switched; then it is `git add`ed.
- Two Melodic traps: a component that first renders an empty template (``html`` ``) never shows a later non-empty one, so render `nothing()` (ai-entry.ts) instead; and `computed()` created while a component renders is disposed with that component, so a store with computed fields is instantiated at module load (end of ai-features.store.ts) and its effects are created outside any component.

## Integrated terminal

```
src-tauri/src/terminal.rs          shells on a pseudo-terminal (portable-pty: Unix ptys, Windows ConPTY): term_open / term_write /
                                   term_resize / term_close, `term-data` and `term-exit` events
src/services/terminal.store.ts     every terminal with its xterm.js screen; the panel's open/closed state and height (studio.terminal.*)
src/shared/xterm.ts                lazy xterm.js load, its CSS adopted into the shadow root, theme from --ml-*/--ms-* tokens
src/components/terminal            ms-terminal: the panel under the main pane (tabs, top edge to drag, Ctrl+` / Ctrl+Shift+`)
src/services/demo-terminal.ts      the pretend shell of the browser preview
```

- The shell is the user's own: `$SHELL -l` on Unix (a login shell, because a GUI-launched app has almost no environment), `pwsh.exe`, else `powershell.exe`, else `%COMSPEC%` on Windows. It starts in the active checkout (`commands::repo`), so a new terminal follows a worktree switch; terminals already open stay where they are.
- Output travels as base64 of the raw bytes (a read can end inside a UTF-8 character) and can arrive before `term_open` has returned the key, so the store holds early events until it knows the key. Keystrokes are sent one write at a time: async commands may otherwise overtake each other.
- The xterm `Terminal` objects live in `TerminalStore`, not in the component: the work area is rebuilt on a repository or worktree switch and the panel is hidden with `display: none`, and neither may cost a shell or its scrollback. `term.open()` runs only once its element is on screen (xterm measures glyphs).
- The end of a shell comes from a thread waiting on the child, not from the output stream: ConPTY never reports end of stream. Closing a terminal hangs up (SIGHUP) on Unix and terminates on Windows; dropping the pty takes the rest along, and the window's `Destroyed` event closes them all.
- Ctrl+` is Ctrl on every OS and is caught in the capture phase, or a focused terminal would send it to the shell. Off the Mac, copy and paste are Ctrl+Shift+C / Ctrl+Shift+V; Windows also gets Ctrl+V and Ctrl+C-with-a-selection.

## Conventions

- Melodic 3-file pattern for big components, single file for small ones. `@Service()` for DI, `@ml:click`/`@ml:input`/`@ml:change` for Melodic events, `@click` for native.
- Never import `@tauri-apps/*` at module top level; lazy-import inside `isDesktop()` checks.
- No hard-coded colors in component styles; use `--ml-*` or `--ms-*`.
- New backend command: add to `git.rs` (with a test), `commands.rs`, the handler list in `lib.rs`, `backend.service.ts` (plus a demo case), then a store action.
- AI one-shots: the pull request draft is `AiService.ask` with tag `[pull-request]`, no tools, input cut to size in Rust (`pr_changes`); it must answer `{"title","body"}` and falls back to a draft from the commit subjects when Claude is unavailable.
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

Built and checked in the browser preview (demo backend) and by Rust tests against real git. Not yet run as a desktop window, so agent sessions and language servers have only been exercised piecewise: the `claude` CLI invocation and its event format by hand, LSP framing by unit test, the agent UI against demo events. Not done: integrated terminal, cherry-pick UI (backend command exists), partial (line/hunk) commits, image diffs, background auto-fetch, in-app updater, signing/release workflow, renaming the folder.

Host integration: the GitHub path was run against the real `gh` (status, issue list and search, default branch, owners; `gh pr create --dry-run` for the arguments). Azure DevOps was exercised only as far as a signed-out `az` allows (status and the sign-in hint); its work item, pull request and repository output is parsed from the extension's source and documented shapes. `glab` was not installed, so GitLab is parsed from the documented API output only. No pull request or repository has been created for real on any host.
Built and checked in the browser preview (demo backend) and by Rust tests against real git. Not yet run as a desktop window, so agent sessions and language servers have only been exercised piecewise: the `claude` CLI invocation and its event format by hand, LSP framing by unit test, the agent UI against demo events. The AI change features were clicked through in the browser preview with canned answers, and their four prompts were run by hand through the `claude` CLI against real diffs of this repository. Not done: integrated terminal, cherry-pick UI (backend command exists), partial (line/hunk) commits, image diffs, listing issues/work items inside the app (needs host API tokens), background auto-fetch, in-app updater, signing/release workflow, renaming the folder.
