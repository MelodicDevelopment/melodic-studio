# Debugging in Melodic Studio — direction (discussion draft, not approved for build)

## Context
Rick is replacing VS Code with Melodic Studio and needs to debug apps in it. The goal is a debugger designed our
way, not one that matches VS Code feature for feature. Languages: C# first, then TS/Node (+browser), Python, Go,
Rust/C/C++, PHP. Both launch and attach.

## Design
1. **Use DAP (Debug Adapter Protocol).** Reuse existing adapters: netcoredbg (C#), js-debug, debugpy, dlv,
   lldb-dap, vscode-php-debug. vsdbg is ruled out: its license limits it to Microsoft products and it requires a
   handshake only Microsoft clients can answer.
2. **Targets instead of config files.** Studio finds what can be run: csproj + `launchSettings.json` profiles,
   package.json scripts, Cargo binaries/tests, Go main packages, Python entry points. Entries from an existing
   `launch.json` are read and listed too, but are never required. Each target gets Run and Debug; Run starts under
   the debugger by default (a per-target switch), so a breakpoint set mid-run just works.
3. **Sessions run in Rust (`src-tauri/src/dap.rs`)**, unlike LSP. The session state (threads, stopped location,
   stack, breakpoints) lives there, so it survives UI rebuilds and worktree switches, and Claude can use it too.
   Reuse `read_message`/`write_message` from `lsp.rs`; support stdio and TCP adapters; start adapters with
   `proc::command` and stop them with `kill_tree`. Adapter lookup modelled on `lsp/servers.rs` (project copy ->
   managed -> PATH). The window gets a state model over events, not raw protocol messages.
4. **Stopping takes over the main pane.** Source at the current frame with inline values, call stack and
   variables side by side. Program output goes to a real terminal tab in the bottom panel (`runInTerminal` on the
   existing ptys). Breakpoints are saved per repository and pinned to the line's content, so they survive branch
   switches and rebases.
5. **Claude can drive the debugger.** A local MCP server (same pattern as the hook receiver in `conversation.rs`)
   exposes debugger tools: set breakpoints, run, read the stack and variables, evaluate. An agent can debug a
   failing test in its own worktree; "why is this null?" sends the paused state to Claude. Each worktree's debug
   run gets its own port (`ASPNETCORE_URLS` / `PORT`) so two worktrees of one app don't collide.
6. **We maintain our own netcoredbg builds.** A fork built in CI for macOS arm64/x64, Windows and Linux; pinned
   version + checksum, installed by Studio. Fixes sent upstream. Debugging tests: `dotnet test` with
   `VSTEST_HOST_DEBUG=1`, then attach (needs a test view).

## Order
0. Test netcoredbg on Rick's Mac (arm64) with a Node DAP script against a sample ASP.NET app: breakpoints,
   stepping, variables, evaluate, attach.
1. Core + C#: Rust session engine, Targets, stop view, breakpoints in the editor gutter, launch + attach (process
   picker).
2. Claude's debugger tools (MCP).
3. Python, Go, Rust/C/C++ (debugpy, dlv, lldb-dap).
4. js-debug (Node + browser, child sessions, source maps), PHP/Xdebug, test view.

## Out of scope for now
Full `launch.json`/`tasks.json` engine, data breakpoints, restart frame, disassembly, compound configs. Added only
if missed in real use.

## Open decision
Managed installs of netcoredbg and js-debug mean downloading pinned, checksum-verified GitHub release archives.
This changes the current rule that managed installs come only from npm or `dotnet tool`.

## Verification (when built)
- `cargo test` for DAP framing and session state against a scripted fake adapter.
- Node smoke script (like `scripts/lsp-smoke.mjs`) against the real netcoredbg.
- Desktop window via `STUDIO_DEV_EVAL`: launch a sample ASP.NET app, hit a breakpoint, step, inspect, attach.
