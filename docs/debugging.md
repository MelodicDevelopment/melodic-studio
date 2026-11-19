# Run & Investigate: debugging without a debugger

Approved by Rick on 2026-11-18. This replaces the earlier DAP debugger plan (netcoredbg, breakpoints, stepping), which
is dropped.

Design canvas (four screens, the Replay one is clickable): https://claude.ai/artifact/5E3BycqLsWMEtrfNXVg5xZ

## The idea

Rick runs an app from Studio. When something goes wrong, he clicks **Investigate**. Claude reproduces the failure in
its own worktree, adds temporary recording to the code on the failure's path, runs it again, and finds the cause.
Rick gets back a report with the cause, the evidence and a fix, plus a **Replay** of the recorded run that he can
scrub forwards and backwards line by line, with real values. Nobody sets a breakpoint or steps through code.

Why: Claude already debugs by forming a guess, adding logging, running, and reading the output. That covers most bugs
in every language, with nothing to install. The person's job becomes judging the explanation, and the report and
Replay are the proof. A recorded run can also go backwards, which a debugger can't.

## What gets built

Two parts now, in this order. Rick uses the result after Part 2 before anything else is decided. Part 3 (Docker and
Envy) comes later.

### Part 1: Run

**What Rick sees** (canvas screen 1)
- A Run control on the right of the toolbar, before the Claude workspace button and away from the git controls: the
  selected target's name, a dropdown arrow, Restart, and Stop. When the target is running the control shows azure
  equalizer bars and a magenta border. A checkout with nothing to run has no Run control.
- The dropdown lists every target Studio found, grouped by where it came from ("Shop.Api · launch profiles",
  "Shop.Tests", "web · package.json"). Each row shows its name and its command line in mono; a group's heading says
  which file it was found in when pointed at. With more than eight targets the list gets a filter box, and its groups
  fold: the group of the selected target and any group with something running start open.
- A target runs in its own tab in the bottom terminal panel, with live output. The tab shows an error count badge.
- When Studio spots an error in the output, it puts an **Error spotted** bar over that block of output: a one-line
  summary (for example "POST /api/orders returned 500 · NullReferenceException in ApplyDiscount"), Dismiss, and
  **Investigate** (purple, since it hands off to Claude). File:line references in the stack trace are links. The
  line that crashed gets a red marker and a "Crashed here" note in the Files tab editor.

**Targets** (`src-tauri/src/targets.rs`, command `targets_list`)
- .NET: each `*.csproj` with `Properties/launchSettings.json` gives one target per profile whose `commandName` is
  `Project` (`dotnet run --project <csproj> --launch-profile <name>`). A test project (references
  `Microsoft.NET.Test.Sdk`) gives `dotnet test <csproj>`.
- Node: every `package.json` outside `node_modules` gives one target per script. The package manager is chosen from the
  lockfile (`npm`, `pnpm`, `yarn`, `bun`).
- Rust: `cargo run` per binary (`src/main.rs`, `src/bin/*`, `[[bin]]`), and `cargo test`.
- Go: `go run ./<dir>` per `package main`, and `go test ./...`.
- Python: `[project.scripts]` in `pyproject.toml`, `manage.py runserver`, `pytest` when it is configured.
- Each target is a name, a group, a working folder (repository-relative) and an argv. There is no shell line, as in
  the process rules.
- `launch.json` and `tasks.json` are not read.
- The selected target per repository is kept in localStorage.

**Running**
- A target runs on a pty through `terminal::start` with the target's argv as the program, in the active checkout
  (`commands::repo`), so it shows in the bottom panel and Stop and Restart reuse `term_close`.
- Each worktree gets its own port: `ASPNETCORE_URLS` for .NET, `PORT` for everything else. The main checkout keeps the
  app's own port. A worktree gets a free port, chosen once and remembered.
- Studio, not the user, started the process, so it knows the exact command, the exit code and the full output. That
  is what lets Investigate reproduce the failure reliably.

**Spotting errors** (`src/shared/error-spotting.ts`, pure TypeScript with `npm test` tests)
- It reads the output stream, after the ANSI codes are removed, and finds blocks:
  - .NET: `Unhandled exception`, a `fail:` log entry followed by an exception and `at ... in file:line` lines.
  - Node: `Error:` followed by `    at ` lines.
  - Python: `Traceback (most recent call last):`.
  - Rust: `panicked at`.
  - Go: `panic:` plus the goroutine trace.
  - Test failures: `dotnet test` "Failed", jest and vitest "FAIL", `cargo test` "test result: FAILED", pytest
    "FAILED".
  - A non-zero exit code.
- Each block gives a summary, the exception type, the frames it could read (file, line, function) and the raw text.
  That record is what Investigate receives.
- Investigate also works on text selected in any terminal, and on a bug described in words with no output at all.

### Part 2: Investigate

**What Rick sees, while it runs** (canvas screen 2)
- The main pane shows the investigation:
  - The title "Investigating" with purple equalizer bars, and the error's summary.
  - Chips: the worktree name, "its own port 7251", "Your files are untouched".
  - Stop.
- On the left, a checklist that Claude advances:
  1. Read the error and the code on its path
  2. Find the failing request or input
  3. Add recording to N functions
  4. Run it again, recording
  5. Narrow down the cause
  6. Write the fix, plus a test that fails without it
- On the right:
  - A magenta approval card when Claude needs to run something: what it will run, on which port, and what it touches
    (for example "It uses your ShopDev database, so one test order will be written"). Buttons: **Allow once**,
    **Always allow for <target>**, and Don't run.
  - A purple "Claude's thinking so far" card.
- The bottom panel has a tab for the investigation's own run of the app, so its output is visible.
- The investigation appears in the sidebar's Agents tab under "Investigations", and on the agent board. Its status
  dot is magenta "Waiting for you" while the approval card is open, and green "Cause found · fix ready" at the end.

**What Rick sees, at the end: the report** (canvas screen 3)
- A green line, "CAUSE FOUND · <time> · <n> runs", then the cause in one sentence as the heading.
- **The path it took**: one card per function, from the entry point to the crash, each with file:line and the values
  recorded there. The card where the cause is has a purple outline and the crash card is red. An **Open Replay**
  button sits beside the heading.
- **The evidence**: one row per idea Claude tested, tagged RULED OUT (grey), CONFIRMED (green) or ALSO FOUND (amber),
  with the recorded value and a file:line link.
- **The fix**: the diff. Below it, the new test's name and "fails before, passes after", then **Accept fix**
  (magenta), Review in Changes, and Discard. Under the buttons: "The recording Claude added is gone. Only the fix and
  the test are left."
- A follow-up box at the bottom. A follow-up continues the same session (`--resume`), and Claude may run and record
  again.

**What Rick sees in Replay** (canvas screen 4, which is interactive in the canvas)
- On the left, "What ran, in order": one row per recorded step, indented by call depth, with the function name and
  file:line. The cause step is purple, the crash step red, steps already passed azure.
- In the middle, the source of the current step's function. The current line is highlighted, and each line carries
  the value recorded there in a mono chip. Claude's note for that step, if it wrote one, sits under the code.
- At the bottom: step back, Play/Pause, step forward, a timeline with one dot per step, the labels "Request arrives",
  "Cause · step N" and "Crash · step M", and "Step X of Y".
- Replay opens on the cause step, not the first step.

**How it works**
- An investigation is an agent session of a new `kind: 'investigate'` (next to `task` and `ask` in
  `agents.store.ts`), in a new worktree on the branch `investigate/<slug>`. It starts with `base` set to HEAD, like
  parallel attempts.
  - Its first prompt (in `ai-prompts.ts`) carries the error record, which is untrusted text: fenced and labelled as
    program output. It also carries the target, the rules below, and the recording format.
  - Its tools are Read, Grep, Glob, Edit and Write, plus Bash for building only (`dotnet build`, `cargo build`,
    `npm run build`, and the like).
  - Running the app, sending a request to it, and running tests go only through Studio's own tools, so Studio can ask
    Rick first.
- **Studio's tools for Claude** are a local MCP server over HTTP on 127.0.0.1, with a secret in the URL, the same
  pattern as the hook receiver in `conversation.rs`. The session gets it through `--mcp-config`.
  - `run_target(target)` starts or restarts the target in the worktree on its port.
  - `http_request(method, path, body)` sends a request to that port.
  - `run_tests(filter)` runs the target's tests.
  - `stop_target()` stops it.
  - Each call that runs something waits for Rick's answer on the approval card, unless he chose "Always allow" for
    that target (kept per repository in localStorage).
  - Check before building this: `claude -p` with `--strict-mcp-config` and our HTTP server, while still skipping the
    user's own MCP servers and skills.
- **Recording.** Claude adds one-line recording calls to the functions on the path. Each line ends with the marker
  comment `studio-replay`. Each call appends one JSON line to `<worktree>/.studio/replay/run-<n>.jsonl`, and the prompt
  gives a small helper per language:
  - `{"seq":1,"event":"enter"|"line"|"return"|"throw","fn":"PricingService.ApplyDiscount","file":"src/Shop.Pricing/PricingService.cs","line":39,"depth":2,"values":{"tier":"null"}}`
  - The helper takes the line number from the language: `[CallerLineNumber]` in C#, `line!()` in Rust,
    `runtime.Caller` in Go, `inspect` in Python, the `Error().stack` in JavaScript. It also caps each value at 200
    characters.
  - When a run starts, Studio keeps a copy of every instrumented file. Replay shows each file with its marker lines
    taken out, and maps recorded line numbers back to that clean text. Steps and values therefore always match the
    code Rick sees.
  - `.studio/` goes in the worktree's `info/exclude`.
- **Cleanup.** Before the fix is shown, Studio checks the worktree's diff against `base` for any `studio-replay`
  line. If one remains, the session is told to remove it first. The fix is never offered with recording left in it.
- **Claude's last answer** is JSON, parsed in `ai-prompts.ts` like the other features:
  - `summary`
  - `path` (fn, file, line, values)
  - `evidence` (status `ruled-out` | `confirmed` | `also-found`, title, detail, file:line refs)
  - `run` (which `run-<n>.jsonl` the Replay uses)
  - `causeSeq`, `crashSeq`
  - `notes` (seq to text)
  - `test` (name, failsBefore, passesAfter)

  The fix itself is the worktree's diff (`worktree_diff`), not text in the answer.
- **Accept fix** is the existing Merge… flow (`AgentsStore.merge`). Review in Changes switches to the worktree.
  Discard removes the worktree and its branch.
- Text from the program's output and values recorded from the app are untrusted and are shown as text only. Claude's
  notes go through `rich-text.ts`.

### Part 3 (later): apps in Docker, with Envy URLs

Not part of the first build. Parts 1 and 2 cover apps that run directly on the Mac. Rick runs some of his apps in
Docker containers, and Envy (his own app: `/Applications/Envy.app`, source in `../envy`) gives every container an
`https://<name>.<domain>` URL.

- **Targets:** each service in a `compose.yaml` / `docker-compose.yml` is a target. Studio drives the user's own
  `docker compose` CLI, like it does git and gh. No Docker API and no dockerode. Run is
  `docker compose -p <project> -f <their file> -f <our override> up --build <service>`, and its output goes to the run
  tab, so error spotting works unchanged.
- **One container set per worktree:** the compose project name (`-p`) comes from the worktree. The investigation's
  copy then never collides with the app Rick is running.
- **Recording:** the worktree's source is built into the image (or mounted), and the override mounts `.studio/replay/`,
  so the recording file lands on the Mac where Studio reads it.
- **Envy needs no changes to work.**
  - It watches Docker, so containers Studio starts get URLs by themselves.
  - Studio names each URL in advance: the override file (in the app cache dir, never in the repository) sets the label
    `envy.host=<worktree>-<service>`. That gives URLs like `https://investigate-nre-api.envy.local`.
  - Without that label, two projects with the same service name collide, and Envy quietly falls back to the
    container's name (`hostsFor` in `envy/src/engine/discovery.ts`).
  - The domain comes from Envy's `config.json` (`domains`).
  - `http_request` calls that URL instead of `localhost:<port>`, and the approval card and the report show it.
  - When Envy isn't installed, Studio uses the published port.
- **Envy changes worth making (optional):**
  1. Envy writes its live route table (host → container) to a file next to `config.json`, so Studio shows the real URL
     instead of predicting it.
  2. Envy can route a host to a port on the Mac, not only to a container. Then plain Run targets (`dotnet run`,
     `npm run dev`) and every worktree's copy of them get Envy URLs too.
- Nothing of Envy is copied into Studio. Its proxy, DNS and certificate authority need a privileged daemon, and Studio
  uses Envy when it is installed.

## Rules

- Claude never runs the app, sends it a request, or runs tests without Rick's OK, unless he chose "Always allow" for
  that target.
- Rick's files and branch are never touched. Everything happens in the investigation's worktree until he accepts the
  fix.
- Recording code never reaches a fix (the cleanup check above).
- No debugger, no breakpoints, no adapters, nothing installed.

## Not now

All of these are possible later if real use shows a need:
- A traditional debugger, breakpoints or stepping.
- "What's it doing right now?" snapshots of a hung app (`dotnet-stack`, `py-spy`, `sample`).
- Recording from OpenTelemetry traces.
- Reading `launch.json`.
- Compound targets.

## Verification

- `cargo test`: target discovery against fixture folders (.NET, Node, Cargo, Go, Python), the MCP server's tool calls
  against a fake session, and the free-port choice.
- `npm test`:
  - error spotting against captured real output for each runtime and test runner
  - the recording line mapping (instrumented to clean)
  - the parser for the final answer
- Browser preview: demo targets, a demo run that crashes, and a demo investigation from the approval card through to
  the report and Replay.
- Desktop window via `STUDIO_DEV_EVAL`: a sample ASP.NET API with the canvas's bug (an archived loyalty tier makes
  `GetTier` return null). Run it, spot the error, investigate, approve the run, get the report, replay, accept the
  fix.

## As built (2026-11-18)

Parts 1 and 2 are built on `feature/run-and-investigate` and were run for real against a sample ASP.NET API with the
canvas's bug. Where the build differs from the text above, and what was found on the way:

- **The check before building passed.** `claude -p --strict-mcp-config --mcp-config <file>` reaches Studio's HTTP
  server and loads none of the user's MCP servers or skills (2.1.327). Investigations also run with `--restricted`, so
  the user's own Bash allow-rules cannot let the session run the app behind Studio's back: a `curl` was refused while
  a command on its allow-list ran.
- **Ports for .NET.** `ASPNETCORE_URLS` alone is not enough: `dotnet run --launch-profile` replaces it with the
  profile's `applicationUrl`. Studio also sets `Kestrel__Endpoints__Http__Url`, which wins over the profile.
- **Seq and depth are Studio's, not the helper's.** A step's number is its line in the `.jsonl` file and depth comes
  from the enter and return events. One helper per project (Shop.Api, Shop.Checkout, Shop.Pricing each needed one)
  cannot keep a shared counter. Claude reads the file to give `causeSeq` and `crashSeq`.
- **Where a recording line points.** At the line of code above it; a "return" at the line below (it is recorded just
  before the statement). Blank lines and comments are skipped both ways.
- **More tools than the four.** `progress` (the checklist and "thinking so far"), `target_output`,
  `remove_recording_file` (the session has no other way to delete its helper file) and `stop_target`.
  `http_request` and `run_tests` each ask, like `run_target`.
- **The "Error spotted" bar** sits between the tabs and the terminal rather than over the block inside xterm, and its
  frames are the file:line links. The crash mark in the Files tab is as designed.
- **Accept fix commits first.** Agents do not commit, so Accept fix commits the worktree as the user (their message,
  no trailer) and then opens the ordinary Merge dialog.
- **Targets also include** a .NET project with no launch profile that is runnable (web, worker or `Exe`), and a Cargo
  workspace's `cargo test --workspace`.

