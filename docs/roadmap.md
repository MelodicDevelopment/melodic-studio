# Upcoming features

Requested 2026-11-18. Notes say where each one plugs into what exists today.

## 1. Reveal a file in the file manager

Files tab context menu (`components/explorer/explorer.component.ts`, next to "Copy path"): **Reveal in Finder** /
**Show in File Explorer** / **Show in file manager**, the same labels the toolbar already uses
(`toolbar.component.ts` `reveal`). Also worth adding to the Changes list context menu.

- Today `open_in('finder')` only opens the repository folder (`opener().open_path`). Add a repo-relative `arg`,
  resolved through `files::resolve()`, and select the item rather than open it: tauri-plugin-opener's
  `reveal_item_in_dir` (macOS `open -R`, Windows `explorer /select,`, Linux FileManager1 D-Bus `ShowItems`, falling
  back to opening the parent folder with `xdg-open`).
- A deleted file (shown in Changes) has nothing to reveal: reveal its folder, or hide the item.

## 2. File > New Project

The window has Tauri's default menu (no `Menu` is built in `lib.rs`). Build our own with `tauri::menu` in `setup`,
keeping the standard Edit / View / Window items, and add **File > New Project…** (also on the welcome screen).

### Templates are data, not code

One registry (`src-tauri/src/templates.rs`, or a bundled `templates.json`) describing each template: id, name, group,
icon, the tool it needs (+ how to check it runs and what to install), its options, and the argv steps to run.
The dialog, the tool checks, the progress pane and the hand-off to the wizard are written once; adding a framework is
one entry. Steps are argv lists with `{name}` / `{dir}` placeholders, run through `proc::command()` (no shell).

**Melodic** (listed first, its own group):

| Template | Steps | Options |
|---|---|---|
| Melodic JS app (components included) | `npx @melodicdev/cli init {name}` then `npm install` | Monorepo (`--monorepo --app-name <app>`) |
| Melodic PHP | in a temp dir `composer require melodicdev/framework`, then `php vendor/bin/melodic make:project {name}` with the parent folder as cwd, then `composer install` in the new project | Type: full / api / mvc (`--type=`) |

**Popular:**

| Template | Steps |
|---|---|
| Angular | `npx @angular/cli@latest new {name} --skip-git` (options: routing, style) |
| React (Vite) | `npm create vite@latest {name} -- --template react-ts`, `npm install` |
| Vue / Svelte (Vite) | same, `--template vue-ts` / `svelte-ts` |
| Next.js | `npx create-next-app@latest {name} --ts --no-git` (flag spelling to check) |
| Laravel | `composer create-project laravel/laravel {name}` |
| .NET | `dotnet new <webapi\|mvc\|console\|classlib> -o {name}` |
| Rust | `cargo new {name} --vcs none` (binary / library) |
| Empty folder | nothing; straight to the wizard |

Notes:

- Pass each tool's "no git" flag where it has one, so our setup wizard does git init / .gitignore / first commit
  (with the matching .gitignore template pre-selected). The wizard must still cope with a folder that is already a
  repository with no commits, for tools that always init.
- Name validation is the strictest of the tool's rules (Melodic CLI: `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`; Melodic PHP:
  letters, digits, `-`, `_`), checked before anything runs. The target folder must not exist.
- Missing tool: say exactly what to install (Node/npm, Composer + PHP, .NET SDK, rustup), like the language servers
  and host CLIs. Nothing is installed for the user.
- Long steps (`npm install`, `composer`) stream into a pane, can be stopped (`proc::kill_tree`), and a failure leaves
  the half-made folder for the user to look at, with a "Remove it" button rather than deleting silently.
- To check: Melodic PHP's `composer require` route assumes `melodicdev/framework` is on Packagist; if not, use its
  git repository as a Composer VCS source. A `melodic new` that runs standalone (or `composer create-project` of a
  Melodic PHP skeleton package) would make this one step, and is worth adding to melodic-php itself.

### Where the repository lives

New Project ends in the setup wizard's existing "where" step (`components/init/init-repo.*`), which already offers
Local only / GitHub / Azure DevOps / GitLab / Bitbucket / Other and creates the remote through `host_repo_create`
(the user's `gh`, `az`, `glab`), then pushes. For New Project:

- Default to **GitHub** instead of Local only (the plain-folder wizard keeps defaulting to Local only). Remember the
  last choice (and owner / Azure organization + project) per user, so Azure DevOps users pick it once.
- The repository name defaults to the project name; Private stays ticked by default.
- **Bitbucket** stays a web hand-off: there is no first-party CLI for it, and we store no tokens and call no host
  API. Open `bitbucket.org/repo/create` (prefilled with the name where the page takes it), the user pastes the
  clone URL back, we add it as `origin` and push. Same for Other.
- Signed-out / missing CLI keeps the wizard's current behaviour: say what to run, offer the web page.

### Your own templates

Later, Settings > Project templates: add entries of the same shape (a command, or a git URL / local folder to copy
from). Stored in the app config dir beside `repositories.json`. The Melodic ones use the same mechanism, just shipped
with the app.

## 3. Settings in the OS menu

- macOS: **Melodic Studio > Settings…** (Cmd+,) in the app menu.
- Windows / Linux: **File > Settings** (Ctrl+,); there is no app menu there. Could also be Edit > Preferences on
  Linux, but File keeps both the same.
- Menu events go to the window (`app.emit`), which opens the existing Settings view. Add Cmd/Ctrl+, as an in-window
  shortcut too, so it works where the menu bar is hidden.

## 4. Drag and drop in the Files tab

Two cases:

- **From outside** (Finder, the desktop): HTML drop events never arrive because Tauri's window file-drop handling is
  on. Listen to `getCurrentWebview().onDragDropEvent` (gives absolute paths and a position), hit-test the position
  against the tree's folder rows to highlight the target, and on drop copy the files in. New backend command
  (`files_import`): destination through `files::resolve()`, sources are absolute paths (`paths::typed`/native), copy
  recursively, never overwrite without asking (offer Replace / Keep both / Skip), refuse dropping into `.git`.
- **Inside the tree** (reorganise): pointer events, not HTML drag and drop (same reason as the rebase rows and the
  workspace tabs). Move with `std::fs::rename` both ends through `resolve()`; for tracked files consider `git mv`
  so the rename shows as one in Changes (git detects it either way once staged). Update open editor tabs and Monaco
  models whose paths moved, and refuse moving a folder into itself.
- Both refresh the tree and status afterwards. Check that the window-level drop handler (if anything else uses it)
  is not stolen from other panes.

## 5. More file operations in the Files tab context menu

Today the menu has Open in new tab / Expand-Collapse, View changes, Copy path, Copy relative path. Add:

- **New File… / New Folder…** (on a folder, or beside a file): inline name field in the tree. Note `files::resolve()`
  and saving currently never create a file, so this is a separate, explicit `files_create` command.
- **Rename** (F2 / Enter on macOS): inline edit; same move logic as drag and drop (section 4).
- **Duplicate**: copies to `name copy.ext`, never overwrites.
- **Delete** (Cmd+Backspace / Delete): moves to the OS trash, like Discard does for untracked files (FreeDesktop
  trash on Linux, falling back to deleting with a confirm). Confirm for folders and for tracked files with changes.
  Close or mark the editor tabs of deleted files; unsaved edits in an open tab ask first.
- **Reveal in Finder / file manager** (section 1), **Open in terminal** (folder, or the file's folder).
- **Ignore**: add the path (or `*.ext`) to `.gitignore`, appending like the setup wizard does.
- Git items when they apply: Discard changes, View history of this file.
- Multi-select (Shift/Cmd-click) so Delete, Move and Reveal take several entries.

All of these go through `files::resolve()` (no `..`, no `.git`, no symlinks out), refuse the repository root,
refresh the tree and status afterwards, and keep Monaco models / open tabs in step with renamed or removed paths.

## 6. Working with the hosts: GitHub, Azure DevOps, Bitbucket, Jira

Today (`host_cli.rs`): issues / work items list, "start agent on this", pull request context / draft / create,
owners and new repositories, all through `gh`, `az` (+ azure-devops extension) and `glab`. Bitbucket is web pages
only; Jira is not there at all.

### What to add

- **Pull requests:** list (mine, review requested, all open), open one in the app (description, checks, comments,
  the diff in `ms-diff`), check it out into a worktree, approve / request changes, comment, merge (merge / squash /
  rebase, delete branch). Azure DevOps: reviewers, votes, linked work items, auto-complete.
- **Issues / work items:** beyond the list: create, edit state / assignee / labels, comment, link to a branch or PR
  ("AB#123" / "Fixes #12" in the commit message), a branch named from the item.
- **CI:** status of the current branch and PRs (GitHub Actions, Azure Pipelines, Bitbucket Pipelines), the log of a
  failed run, re-run. A status dot in the toolbar beside the branch.
- **Jira:** issues assigned to me / in the current sprint, transition, comment, branch from issue key, the key
  picked up from the branch name and offered in the commit message. Links Jira <-> Bitbucket / GitHub via the key.
- **Settings > Accounts:** one row per host: signed in as, which organizations / Azure DevOps projects / Jira sites
  to show, default project per repository (Azure DevOps project and Jira project are not derivable from the remote).

### Decided: the CLIs, no tokens (2026-11-18)

The recorded rule stays: no stored tokens, the app calls no host API.

| Host | Through | Sign-in (done by the user, stored by the tool) |
|---|---|---|
| GitHub | `gh` (`gh pr`, `gh issue`, `gh run`, `gh api`) | `gh auth login` |
| Azure DevOps | `az` + azure-devops extension (`az repos pr`, `az boards`, `az pipelines`, `az devops invoke`) | `az login`, or `az devops login` with a PAT (kept by `az`) |
| GitLab | `glab` | `glab auth login` |
| Jira | Atlassian's `acli` (`acli jira workitem ...`) | `acli jira auth login` |
| Bitbucket | none: web pages, as today (no first-party CLI; unofficial ones are not used) | n/a |

`az` starts Python on every call: batch what we can, cache lists for the session, show progress.

### Telling users to install the CLIs

`host_clis` already reports each tool's status (missing / signed out / signed in as). Build on it:

- **Settings > Accounts**: one row per tool: status, signed-in account, and when missing the exact install line for
  this OS (macOS `brew install gh`, Windows `winget install GitHub.cli`, Linux the distribution's package or the
  vendor's instructions; the same for `az` + `az extension add --name azure-devops`, `glab`, `acli`), a Copy
  button, "Open install page", and "Check again". Signed out: the sign-in command, with "Run in terminal" opening
  the integrated terminal with it typed in (not run).
- **In context**: when a repository's remote is on a host whose tool is missing or signed out, a dismissible notice
  where it matters (Issues dialog, PR dialog, the toolbar's host menu): what it unlocks, the install / sign-in line,
  a link to Settings > Accounts. Dismissed per tool, not per repository; never a modal, never on startup.
- **Jira** has no remote to detect from: offered in Settings > Accounts, then per repository ("Jira project for
  this repository"), and by spotting issue keys (`ABC-123`) in branch names.
- After an install or sign-in, re-check on window focus so the notice goes away without a restart.
- Nothing is installed for the user (as today: `AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no`).
