# Direction

Where Studio goes after the daily-driver plan. From a conversation with Rick on 2026-11-25 about how people will build and
maintain products once typing code is no longer the constraint: the work becomes saying what is wanted and judging what came
back, so what matters is proof that a change works, knowing what needs you, and work that starts without you.

Studio's strength is supervising agents (one rule for where things stand, briefs, the pipeline, the language servers' check
of a change). Its weakest ground is the editor, where VS Code, JetBrains and Zed have whole teams.

## The five

1. **Stop chasing editor parity.** The editor stays good enough to read and fix. New effort goes into supervision.
2. **Ship is an evidence page.** One "why you can trust this" view over the tests, the review, the language servers' check
   and what the loop fixed, with what was *not* checked said as loudly as what was. **Picked first; see CLAUDE.md, "Evidence".**
3. **A running preview per worktree.** Each worktree already gets its own port (`run.rs`). A change judged by using it, not by
   reading its diff, is what lets a designer or a product owner decide. Start: a "Try it" on the evidence page that runs the
   worktree's target and opens it.
4. **Triggers, and a way to be away.** Today the app must be open and Rick in front of it. Work started by an event (a failed
   CI run, a new issue, a dependency update, a schedule), and approving the plan or the ship from a phone. The biggest
   structural gap: it needs something that runs without the window.
5. **Studio owns project memory.** CLAUDE.md's "Decisions (do not regress)" is kept by hand. Studio could offer a decision to
   record when work lands, and hand the relevant ones to a task's plan.

## Risks to keep in view

- Coupling to one vendor's CLI, version by version (flags, hooks, what `-p` hides).
- That vendor's own apps moving into parallel agents in worktrees: the supervision layer has to stay ahead of them, which is
   another reason for 2 and 3.
