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

### 3. Open a file by name

Cmd/Ctrl+P. Reuse the box go-to-symbol already has (`components/explorer/symbol-search.component.ts`) and make it one
"Go to" box: file names by default, symbols with Cmd/Ctrl+T or by typing `@` first. Fuzzy match on the path, the
file name weighing most, recently opened files first when nothing is typed.

The file list is `git ls-files --cached --others --exclude-standard` for the active checkout, kept per checkout and
read again when the status changes. It is also what step 7 needs to know which languages a checkout has.

Done when: any file of this repository is open within three or four keystrokes and Enter.

### 4. Agent history out of browser storage

Sessions move to files in the app's data folder, one per session, through two small commands (load all, save one).
A session is written when its turn ends and at most every half second while it streams; the write is flushed when the
window closes. What is in localStorage `studio.agents` today is moved over once, then removed. If something ever
cannot be saved, the user is told: nothing fails silently.

Where: `services/agents.store.ts` (`save`, `update`, the loader that fills in fields newer than the session), a new
pair of commands beside `config.rs`.

Done when: a transcript of a few thousand items streams without the window stuttering, survives a restart whole, and
a full disk or an unwritable folder shows a message.

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

### 6. Fewer surfaces

A proposal first, as a clickable mock-up for Rick to judge, then build what he approves. Starting points: agents
live in one place (the Agents tab; the toolbar button becomes a count that takes you there, or a popover of the same
list); the Claude pane's own toolbar keeps what is used and folds the rest into a menu; strips and banners above the
transcript share one line and collapse. Nothing is removed without his say.

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

### 8. Format with the project's own formatter

When a project has Prettier (its `node_modules/.bin/prettier` and a config), Format document and format on save use
it for the files it handles, through `proc::command()` with the text on stdin; everything else stays with the
language server. Nothing is installed for the user. The same shape fits `ruff format` and `black` later.

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
