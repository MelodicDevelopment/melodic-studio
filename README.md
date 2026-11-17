# Melodic Studio

A desktop developer workspace for macOS, Windows and Linux: a git client, a code viewer, a terminal, and AI agents that each work on their own branch. Built with [Tauri 2](https://tauri.app) and the [Melodic](https://melodic.dev) framework.

## What it does

- **Git, the GitHub Desktop way.** Check the files you want, commit, push. Branches, merge, rebase, stash, tags, history with per-file diffs, undo and amend for commits that have not been pushed, conflict resolution.
- **Several repositories at once**, as tabs across the top. Each tab remembers where you were.
- **Open any folder.** A folder that is not a repository yet gets a short setup: default branch, `.gitignore`, README, first commit, and a new remote on GitHub, Azure DevOps or GitLab if you want one.
- **Read the code.** A file tree and editor with hover, go to definition, references and errors from real language servers (TypeScript, C#, PHP, Rust), installed on request into the app's own folder.
- **A terminal** in the bottom panel, running your own shell in the repository.
- **AI agents.** Hand a task to [Claude Code](https://claude.com/claude-code); each agent works in its own git worktree and branch, so several can run while your checkout stays as you left it. Review an agent's diff like any other change, then merge it. Run the same task two or three ways and compare.
- **AI on your changes.** A commit message from the diff, a plain-language explanation of a diff or commit, a review of what you are about to push, and proposed resolutions for merge conflicts.
- **Ask the repository.** Read-only questions about the code or its history, answered with links to the files and commits.
- **Your host.** Issues and work items, and drafted pull requests, on GitHub, Azure DevOps and GitLab.

## How it works

Melodic Studio does not bundle git, store tokens or call any host's API itself. It runs the tools already on your computer:

| For | It uses |
|---|---|
| Everything git | your `git`, so SSH keys, credential helpers, hooks and signing behave as they do in a terminal |
| AI features | your `claude` command (Claude Code) |
| Issues, pull requests, new remotes | your signed-in `gh`, `az` (with the azure-devops extension) or `glab` |

Anything that is missing is simply unavailable, with a note on what to install.

## Install

Download the installer for your system from the [Releases page](https://github.com/MelodicDevelopment/melodic-studio/releases/latest). Once installed, the app keeps itself up to date: new versions download in the background and a "Restart to update" prompt appears when one is ready.

Requirements: git; macOS 14 or newer, Windows 10/11, or a Linux desktop with WebKitGTK 4.1.

## Build from source

```sh
npm install
npm run desktop:dev     # the app, with hot reload
npm run dev             # the interface alone in a browser, on demo data
```

You need Node (see `.nvmrc`), Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system. Checks:

```sh
npx tsc --noEmit && npm test
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```

Releases are described in [docs/release.md](docs/release.md); the layout of the code and the decisions behind it are in [CLAUDE.md](CLAUDE.md).
