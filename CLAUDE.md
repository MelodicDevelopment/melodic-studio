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
  paths.rs      how absolute paths are spelled and compared (native / same / typed), and the PATH fix for
                GUI-launched apps so git, ssh and claude resolve
  proc.rs       the only way to start a process (command), stop one (kill_tree), or hand off to the user's
                editor and terminal (open_editor / open_terminal)
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
  shared/paths.ts       the only place absolute paths are compared or taken apart (samePath, relativeTo, joinPath, fileName)
  shared/platform.ts    web view minimum check at startup; turns off the web view's reload keys and page menu in the packaged app
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

## Platforms

macOS, Windows and Linux are all first-class. CI (`.github/workflows/ci.yml`) runs typecheck, `npm test`, the build, clippy and `cargo test` on all three; the Rust tests run the runner's real git. Only macOS has been run by hand so far (see the end of this section).

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
```

## Status / next

Built and checked in the browser preview (demo backend) and by Rust tests against real git. Not yet run as a desktop window, so agent sessions and language servers have only been exercised piecewise: the `claude` CLI invocation and its event format by hand, LSP framing by unit test, the agent UI against demo events. Not done: integrated terminal, cherry-pick UI (backend command exists), partial (line/hunk) commits, image diffs, background auto-fetch, in-app updater, signing/release workflow, renaming the folder.

Host integration: the GitHub path was run against the real `gh` (status, issue list and search, default branch, owners; `gh pr create --dry-run` for the arguments). Azure DevOps was exercised only as far as a signed-out `az` allows (status and the sign-in hint); its work item, pull request and repository output is parsed from the extension's source and documented shapes. `glab` was not installed, so GitLab is parsed from the documented API output only. No pull request or repository has been created for real on any host.
Built and checked in the browser preview (demo backend) and by Rust tests against real git. Not yet run as a desktop window, so agent sessions and language servers have only been exercised piecewise: the `claude` CLI invocation and its event format by hand, LSP framing by unit test, the agent UI against demo events. The AI change features were clicked through in the browser preview with canned answers, and their four prompts were run by hand through the `claude` CLI against real diffs of this repository. Not done: integrated terminal, cherry-pick UI (backend command exists), partial (line/hunk) commits, image diffs, listing issues/work items inside the app (needs host API tokens), background auto-fetch, in-app updater, signing/release workflow, renaming the folder.
