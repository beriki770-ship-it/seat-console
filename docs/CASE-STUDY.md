# How I run a multi-agent Claude Code setup

Beri Kirsh, Imst, Austria. November 2026.
Public code: [seat-console](https://github.com/beriki770-ship-it/seat-console) · [dispatch-skill](https://github.com/beriki770-ship-it/dispatch-skill) · [handoff-skill](https://github.com/beriki770-ship-it/handoff-skill)

I run a one-person software studio. Agents write most of the code. I write the specs, split the work, and decide what counts as done. This page shows the three parts of the setup and how I check what comes out of it.

## 1. Seat Console: many sessions, one place

The problem: several Claude Code sessions in several terminal windows. It is hard to see which one waits for an approval, and a crash or a closed window takes the running session with it.

The build: a local web console, also usable from the phone as a PWA and through a Telegram bot.

- Every conversation is one long-lived `claude -p` process with stream-json in and out, running inside its own detached host process. The server can restart or crash and the turn keeps running. At start the server reattaches to every host and replays missed output and pending approvals.
- A supervisor restarts the server within seconds of any exit. After a real PC crash, turns that were cut off are marked `interrupted`. They do not resume by themselves, because resuming spends quota. I resume them with one tap.
- Permission modes per conversation: `auto`, `ask` (Allow once or Deny cards, also on the phone) and `bypass`, which shows a red badge.
- Cron routines never run unattended. At the due time a Telegram message asks Run or Skip.
- Each seat has its own config folder and shares skills, hooks and agents with the main setup.
- Node.js, zero npm dependencies, no build step. It launches the unmodified Claude CLI and never touches credentials.

## 2. Dispatch: one planner, many workers

A rule set I load into the top model. It plans and verifies; subagents execute.

- Each task goes to the cheapest model tier that can do it well: Haiku for mechanical work, Sonnet for standard engineering, Opus for judgment.
- Independent tasks run in parallel, in separate git worktrees when they touch code.
- Every agent returns the same four fields: STATUS, CHANGED, VERIFIED-BY, NOTES. VERIFIED-BY names the check the agent actually ran.
- If verification fails, the task goes one tier up instead of being retried on the same model.
- A plan gate stops expensive fan-outs before they start. A dispatch ledger records what was sent and what came back, so a session that crashes mid-dispatch can resume.

## 3. Memory that survives the session

- Handoff: a Stop hook blocks a session from ending when it made real edits but wrote no handoff note.
- Ledger: an append-only project log plus a short orientation file. A PreToolUse hook injects the orientation and the matching records into the agent's context, so a new session starts with the facts it needs instead of reading everything.

## Failure modes I hit, and what fixed them

| Failure | Fix |
|---|---|
| Console restart killed running turns | Detached host process per conversation, reattach on start |
| PC crash left turns half done, unseen | `interrupted` state, resume on tap, never automatic |
| Agent says "done" without proof | Fixed return format with a VERIFIED-BY field; a failed check goes one tier up |
| New session forgets what the last one learned | Handoff Stop hook, ledger injection |
| First public CI run failed | The runner clock was UTC, a routine test assumed Vienna time. Set TZ in the workflow |

## How the output is verified

- 16 offline test files, no Claude account needed, run on GitHub Actions on every push and pull request, on Windows, Ubuntu and macOS runners. Latest runs green.
- `smoke-fake.mjs` starts a test instance against a fake claude, kills the server hard in the middle of a turn, and checks reattach, Stop and leftover processes.
- Before the repo went public: a secret scan with detect-secrets (0 hits), and a grep for my own name, 60 hits down to 0.
- The README states what is tested and what is not. Windows is used daily; Linux passes the offline tests and the fake smoke test; macOS is written but not tested on real hardware.

Seat Console is independent and unofficial, not affiliated with Anthropic. Apache-2.0.
