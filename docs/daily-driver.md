# Daily driver: from a good git client to an IDE people live in

Requested by Rick on 2026-11-19, after an honest look at where Studio stands. The verdict was: a very good git client
and agent workspace with a capable code viewer, wide and thin, not yet an IDE to work in all day. This is the plan to
change that. Work it top to bottom; each step stands alone and is finished (run in the real window, noted in
CLAUDE.md) before the next starts.

Starting point: the IntelliSense work (completion, rename, quick fixes, the agent check, and the rest) is on
`feature/intellisense`. Commit it before starting here.

## What was found

Measured or seen on 2026-11-19, on macOS, in a dev build:

- The editor is squeezed. The Claude pane opens beside the main pane by default (`WorkspaceStore._firstView` is
  `side`) and took half of a 1500 px window; the code column showed about 35 characters.
- No find-in-files and no open-file-by-name. (Go to symbol exists: `ms-symbol-search`, Cmd/Ctrl+T.)
- Memory: the web view sat near 800 MB after a session across three tiny repositories. Language servers add 150 to
  550 MB each (rust-analyzer: 542 MB for a 20-line project); they are now stopped after ten minutes off screen.
- Agent history: `AgentsStore.save` rewrites every session into localStorage on every streamed event. That is slow
  with long transcripts, the storage has a small cap, and when it is full the write fails silently.
- Many surfaces at once: four sidebar tabs, a right pane with its own toolbar, a bottom terminal, strips and banners.
  Agents are listed in three places (the Agents tab, the toolbar's board, the workspace).
- Much has never been used for real: see "Not run for real" in CLAUDE.md. Windows and Linux have never run, CI has
  never run, updates have never been exercised.
- The startup bundle is fine (1 MB; Monaco loads on demand). Format on save exists (Settings, off by default) but
  goes through the language server or Monaco only: a project's Prettier is ignored.

## The steps

### 1. The editor gets its room

The main pane must never be the narrow one. Recommended, unless Rick says otherwise: the Claude pane still opens
beside the main pane for a new repository, but at a third of the window, and it gives way: the main pane keeps at
least 720 px, and when the window cannot give it that the Claude pane is hidden behind its toolbar button rather than
shown squeezed. A width the user dragged is kept, within the same floor.

Where: `services/workspace.store.ts` (`_firstView`, `DEFAULT_WORKSPACE_W`, `MIN_WORKSPACE_W`, `width`), the app
shell's resizer in `components/app`.

Done when: in a 1500 px window with the sidebar and the Claude pane both open, the editor shows 100 columns or more;
in a 1100 px window nothing overlaps and the editor is still usable.

**Built 2026-11-19.** The floor is 840 px, not 720: measured in the window, a 720 px main pane shows 75 columns
(63 px of line numbers and folding, 84 px of minimap, 7.4 px a column), and 100 columns need 840 px with the minimap
out of the way. So the editor also drops its minimap while it is too narrow to show 100 columns beside it (under
about 940 px) and brings it back when it is wider. The Claude pane is a third of the window until dragged, never
under 320 px, and is not shown beside the main pane when the two do not fit (with a 300 px sidebar: windows under
1462 px); its toolbar button then swaps the main pane for the workspace alone. Its bar folds its labels to icons
under 520 px. Double-clicking the pane's edge goes back to a third.

| Window | Main pane | Claude pane | Editor columns | Minimap |
|---|---|---|---|---|
| 1500 | 840 | 358 | 102 | off |
| 1500, Claude pane hidden | 1199 | | 134 | on |
| 1462 | 840 | 320 | 102 | off |
| 1460 | 1159 | hidden | 129 | on |
| 1250 | 949 | hidden | 102 | on |
| 1100 | 799 | hidden | 97 | off |

### 2. Find in files

Cmd/Ctrl+Shift+F. A search box at the top of the Files tab's sidebar that swaps the tree for results while it has
text (not a fifth sidebar tab: there are enough). Results grouped by file, the matching line shown with the match
marked, a click opens the file at the line. Options: match case, whole word, regular expression. Capped (say 2,000
matches) with a line saying so.

Backend: `git grep` in the active checkout, with `--untracked` so new files are found and `.gitignore` is respected,
`-n --column -I` (no binaries), the pattern as its own argument after `-e`, never a shell line. One command in
`git.rs` with a test against a real repository (a file name with spaces, a pattern starting with `-`, a binary file,
an ignored folder). A search in flight is dropped when the text changes.

Done when: searching this repository for `GIT_LITERAL_PATHSPECS` answers in well under a second and every result
opens at the right line.

**Built 2026-11-19.** `Git::grep` (git.rs) behind `files_search`; `shared/search.ts`, `SearchStore`,
`ms-find-in-files`. In the window, on this repository: `GIT_LITERAL_PATHSPECS` answered in 31 ms and all six results
opened with the cursor on the match; a one-letter search stopped at 2,000 lines in about half a second. The box also
starts from the editor's selection, Enter searches again, Esc clears, and the arrow keys walk the results. Not
built: include and exclude patterns, replace, searching inside submodules (`git grep` cannot combine that with new
files), and results that refresh by themselves when files change.

### 3. Open a file by name

Cmd/Ctrl+P. Reuse the box go-to-symbol already has (`components/explorer/symbol-search.component.ts`) and make it one
"Go to" box: file names by default, symbols with Cmd/Ctrl+T or by typing `@` first. Fuzzy match on the path, the
file name weighing most, recently opened files first when nothing is typed.

The file list is `git ls-files --cached --others --exclude-standard` for the active checkout, kept per checkout and
read again when the status changes. It is also what step 7 needs to know which languages a checkout has.

Done when: any file of this repository is open within three or four keystrokes and Enter.

**Built 2026-11-19.** `ms-go-to` (was `ms-symbol-search`): files by default, `@` or Cmd/Ctrl+T for symbols,
`name:12` opens at a line, several words narrow each other. `Git::files` behind `files_list`, `FileIndexStore`
(the list per checkout, read again each time the box opens; recently opened files in localStorage
`studio.files.recent`), `shared/fuzzy.ts` (fzy's scoring, the file name weighing most). In the window, on this
repository's 234 files: the box opens in 24 ms, a ranking takes 0.1 ms, 216 files come first for some three or four
letters (the start of the name, or initials), and 222 are in the first five for the first four letters of their
name. The rest are look-alikes that take a letter more or an arrow key: the icon sizes, `x.test.ts` beside `x.ts`.

### 4. Agent history out of browser storage

Sessions move to files in the app's data folder, one per session, through two small commands (load all, save one).
A session is written when its turn ends and at most every half second while it streams; the write is flushed when the
window closes. What is in localStorage `studio.agents` today is moved over once, then removed. If something ever
cannot be saved, the user is told: nothing fails silently.

Where: `services/agents.store.ts` (`save`, `update`, the loader that fills in fields newer than the session), a new
pair of commands beside `config.rs`.

Done when: a transcript of a few thousand items streams without the window stuttering, survives a restart whole, and
a full disk or an unwritable folder shows a message.

**Built 2026-11-19.** `history.rs` (`agent_sessions_load`, `agent_session_save`; `<app data>/agent-sessions/<id>.json`,
written beside the file and moved over it), `AgentsStore.save` / `persist` / `write` / `restore`. The transcript also
shows only its last 300 items with "Show earlier", because rendering every item on every event was the other half of
the stutter. In the window: two sessions seeded in localStorage (one of 3,000 items) and one really left there by an
earlier build were moved to files and the key removed; 300 events streamed into the long one over 18 s gave a worst
frame of 54 ms (two over 50 ms, none over 100), one write every 550 ms of at most 31 ms for 357 KB; after a restart
all 3,600 items were back; with the folder read-only one message appeared ("Agent history is not being saved", with
the reason), the file kept its last good copy, and the next change after the folder was writable again was saved; a
reload in the middle of a turn kept the item that had not been written yet. Not run: a disk that is really full (the
same path as the read-only folder), and quitting the app mid-turn rather than reloading the window (a write waits
half a second at most, so that is what could be lost).

### 5. Memory: measure, then cut

Measure first, in a release build (`tauri build` with `tauri.no-updater.conf.json`): the web view after startup,
after opening the Files tab, after three repositories, after a long agent transcript, after an hour of terminals.
Write the numbers here. Then go after the largest holders. Suspects, unverified: Monaco models kept for every
repository visited (`ExplorerStore` snapshots), the transcript rendering every item (window it to the last few
hundred, with "show earlier"), xterm scrollback in `ScreenPool`, sessions held whole in memory.

Also: stop a checkout's language servers when its repository tab is closed or the repository is removed, not only
after ten idle minutes.

Done when: the numbers are in this file, before and after, and the web view after an ordinary hour is at most half
of what it was.

**Built 2026-11-19.** Measured on macOS as the footprint of the window's WebContent process, in a debug-profile
build that carries the production page (`tauri build --debug --no-bundle`): a release build cannot be driven by
script, and the page is what the web view's memory depends on. One scripted session, each reading taken after the
step before it, everything left open. A TypeScript language server was installed and answering.

| | Before | After |
|---|---|---|
| Startup, a repository on the Changes tab | 167 MB | 167 MB |
| Files tab, 6 files open | 348 MB | 215 MB |
| Three repositories, 6 files open in each | 395 MB | 221 MB |
| A 3,600-item agent transcript on screen | 371 MB | 196 MB |
| Three terminals with their scrollback full | 549 MB | 317 MB |
| The same, three minutes later | 549 MB | 265 MB |

What held it, found by opening one kind of file at a time (the welcome screen alone is 107 MB; the Files tab with
nothing open 140 MB; one Markdown file 184 MB; one TypeScript file 342 MB):

- Monaco's built-in TypeScript worker: about 160 MB from the first TypeScript or JavaScript file, never given back
  (350 MB flat over four idle minutes), and kept even after a language server had taken over. It is now stopped
  when a server takes over, and when no such file has been on screen for two minutes; it starts again when one is
  (the built-in checks answered 2 s after coming back).
- Terminal scrollback: 10,000 lines cost about 60 MB a terminal with long output. Now 5,000 (`SCROLLBACK` in
  `services/screens.ts`).
- The transcript rendering every item: cut in step 4 (the last 300, "Show earlier"), so both columns have it.
- Not holders, as it turned out: Monaco models kept for repositories off screen (they are dropped now, files with
  unsaved edits excepted, with no measurable difference) and sessions held whole in memory (a 3,600-item
  transcript is 0.4 MB).

Also built: a repository's language servers are stopped when it is no longer open in any tab.

Not done, and where the rest is: the 107 MB floor is the web view with the whole app loaded at startup, which only
loading components on demand would lower. Without a language server installed, Monaco's worker still holds its
160 MB while a TypeScript file is on screen. Nothing was measured over a real hour, in a release build, or with a
window that was in front the whole time.

### 6. Fewer surfaces

A proposal first, as a clickable mock-up for Rick to judge, then build what he approves. Starting points: agents
live in one place (the Agents tab; the toolbar button becomes a count that takes you there, or a popover of the same
list); the Claude pane's own toolbar keeps what is used and folds the rest into a menu; strips and banners above the
transcript share one line and collapse. Nothing is removed without his say.

**Built 2026-11-19.** The mock-up (https://claude.ai/artifact/NrozH9CkM5vy9GjkgukX2e, "Today" beside "Proposed") went
through five rounds with Rick. What he changed: folding the Claude pane's buttons into menus made him hunt for a new
conversation, for splitting, for filling the window and for the way back from hiding, so every one of those is a
visible button again and only the two rare starts (a new worktree, a terminal) are behind a caret; and a hidden pane
leaves a strip with an arrow where it was, with no second count on it. What was built is in CLAUDE.md under "Fewer
surfaces": agents listed in one place by how they stand, one New button, one toolbar control for the pane and the
count, the pane's bar and the Overview gone, a session's standing on one line with the check as a pill, the worktree
in the toolbar instead of a banner, the checks in the host menu. The right side of the toolbar went from six buttons
to four and the Claude pane from two bars and eleven buttons to one row of six. In the window, on a scratch
repository: all of the pane's buttons against a real Claude Code conversation and a real shell, the strip and its
arrow, a 1280 px window where the pane gives way and comes back alone, the toolbar's list, the Agents tab with every
repository listed, the worktree in the toolbar and the way back. Only in the preview: the check's pill and its
detail (with a made-up check), the checks in the host menu, the count with something really waiting, rows of a
second repository.

### 7. IntelliSense rough spots

- Refactorings that create, rename or delete files ("Move to a new file") are refused today (`workspaceEdit` returns
  null). Offer `documentChanges` with `resourceOperations`, and apply them through `files.rs` (`create`, `relocate`,
  `trash`), still all-or-nothing: check everything, then change anything.
- The "auto fix" shortcut (`editor.action.autoFix`) does nothing although the quick-fix menu works. Unverified
  guess: Monaco's auto-fix wants each action to name the diagnostics it fixes, and `LspService.actions` passes none.
- Go to symbol only covers a language once one of its files has been opened. When the box opens, start the servers
  for the languages the checkout has (from step 3's file list) and say which are covered.
- Rename has run in the window for TypeScript only. Run it for C#, Rust, Python and PHP. If intelephense keeps
  rename behind its licence, say that in the editor instead of failing quietly.
- The agent check: a changed file that is open in the editor is not compared with how it was; Rust's `cargo check`
  errors have no "before"; it takes about seven seconds on a small project. Improve what is cheap, note the rest.

**Built 2026-11-20.**

- File operations in edits: offered (`documentChanges`, `resourceOperations`) and applied all-or-nothing through
  `planEdit` and the Files tab's own create, move and trash. In the window rust-analyzer's "Extract module to file"
  made `src/greeter.rs`, replaced the module in the open `main.rs` and saved it, with a toast and both in Changes.
  What the plan assumed about "Move to a new file" was wrong: typescript-language-server makes the file itself and
  sends plain edits, so that one already worked (run again here: the function moved, the import in the caller
  rewritten). Renaming and deleting files through an edit are covered by `planEdit`'s tests only: no server here
  was made to ask for one.
- Auto fix: the guess was wrong. Monaco keeps the command off until a code action provider names the kinds it
  provides (`providedCodeActionKinds`), and ours named none; Refactor, Source Action, Organize Imports and Fix All
  were off for the same reason. In the window all are on, and Auto Fix turned `gret(` into `greet(`.
- Symbol search: opening the `@` half starts the servers of the checkout's languages and says what it searches.
  In the window, with nothing opened before, "Searches TypeScript and JavaScript" was up within 400 ms and
  `@gree` found `greet` 250 ms after it was typed.
- Rename, through the app's own client against the real servers (`cargo test -- --ignored app_client`, two new
  fixtures): TypeScript, C#, Rust (rust-analyzer 1.97.1) and Python (Pyright) each rename across two or three
  files and every edit applies. intelephense 1.18.5 answers `renameProvider: false` without a licence key, so the
  editor now says "Intelephense renames only with a licence key" at the cursor instead of nothing. Rename was
  not run in the window for the four new languages: what differs per server is the edit it sends, which is what
  the tests check; applying it is the same code that ran in the window for TypeScript.
- The check: the wait for the server's verdict on the files as they were is only paid when the change shows
  errors. On a three-file TypeScript project in the window: 2.0 s for a change with no errors (three waits before,
  about 7 s), 5.5 s for one that breaks a caller in a file it did not touch, found and listed as before.
  Not done, because neither is cheap: a changed file that is open in the editor is still not compared with how it
  was (it would mean swapping the text under an editor someone may be typing in), and `cargo check` still has no
  "before" (it would take a second checkout at the starting commit and a second build).

### 8. Format with the project's own formatter

When a project has Prettier (its `node_modules/.bin/prettier` and a config), Format document and format on save use
it for the files it handles, through `proc::command()` with the text on stdin; everything else stays with the
language server. Nothing is installed for the user. The same shape fits `ruff format` and `black` later.

**Built 2026-11-20.** `format.rs` (`format_tool`, `format_file`) and `services/formatter.service.ts`; how it finds
and runs Prettier and why each file gets a provider of its own is in CLAUDE.md under "The project's own formatter".
In the window, on a scratch repository with Prettier 3.10.1 installed in it and `{ semi: false, singleQuote: true,
tabWidth: 3 }`: a TypeScript file came back in Prettier's style, not the language server's, in about 140 ms, with
the cursor where it was and one undo putting it back; `NOTES.md` and `tsconfig.json`, which have no language
server, were formatted too; a syntax error gave a toast and changed nothing; `src/main.rs` in the same project went
to rust-analyzer (350 ms); a file named in `.prettierignore` was left as it was; and with format on save on, Cmd+S
wrote the formatted text. The finder (nearest copy, config required, a copy that cannot run does not count) and
the process plumbing (text larger than a pipe, a path with a space, the two ways Prettier fails) are Rust tests
against a stand-in script run by the real `node`. Not run: a monorepo package with its own Prettier in the window
(the finder's test covers it), a Prettier plugin, Prettier 2, and anything on Windows or Linux.

### 9. Hardening

- Give the repository a GitHub remote and let CI run for the first time on all three systems (needs Rick).
- One manual pass each on Windows and Linux, by the rules in CLAUDE.md's Platforms section.
- Work down "Not run for real" in CLAUDE.md, running each thing in the window once.
- Then use Studio for all daily work for two weeks, and fix what hurts before adding anything.

## Not in this plan

Kept so they are not lost; each wants its own design first.

- Helping developers understand a code base and its architecture, and get better at the craft (Rick, 2026-11-19).
  The language servers' symbols and references already give a real dependency map to build on.
- A reading view: formatting for readability that changes how a file is shown, never the file.
- Hover and go-to-definition inside diffs; the agent check's "used in" list fed into Review before push.
- The language server as tools for agents (definition, references, diagnostics), and "Fix with Claude" on an error.
- Side-by-side editors.
