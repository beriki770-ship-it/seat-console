# Seat Console

Seat Console is a small local web console for running several Claude Code CLI sessions side by side, one per Claude account ("seat"), from one browser tab or your phone. If you work with more than one account, the usual setup is a pile of terminal windows: you lose track of which one is waiting for an approval, and a crash or a closed window takes the running session with it. Seat Console keeps every conversation in a detached background process, so restarting the console (or the console crashing) does not stop a running turn, and after a real PC crash it shows you what was cut off and resumes it when you tap.

It works with the Claude Code CLI that you installed and signed in to yourself. It does not modify the CLI or talk to any Claude API directly; it starts `claude -p` with stream-json input and output and shows the result.

> **Disclaimer.** Seat Console is an independent, unofficial tool. It launches the unmodified Claude Code CLI that you installed and signed in to yourself. It never reads, stores or transmits your Claude credentials. Each account must be one you are entitled to use; use one account per job and do not use it to get around usage limits. Not affiliated with or endorsed by Anthropic. Review Anthropic's Consumer Terms, Commercial Terms and Usage Policy before use. Use at your own risk.

## Demo video

<!-- TODO(owner): add the demo video link here. -->

## Features

- **Chat UI over several accounts.** The sidebar lists your seats, each with its conversations (title, status, cost). Every conversation is one long-lived `claude -p` process running under that seat's own `CLAUDE_CONFIG_DIR`, so it uses that seat's sign-in. Up to 5 live conversations per seat.
- **Permission modes per conversation:** `auto`, `ask` (approval cards in the chat: Allow once / Deny) and `bypass` (shown with a red badge).
- **Restart-proof.** Each conversation's `claude.exe` runs inside its own detached host process. Restarting or crashing the console server does not interrupt a turn; at start the server reattaches to every host and replays missed output and pending approvals.
- **Crash recovery.** A supervisor (scheduled task) restarts the server within seconds of any exit. After a PC crash, conversations that were mid-turn are marked `interrupted`. Nothing resumes by itself, because resuming spends quota: you resume them with `recover.ps1`, from the Telegram message, or with `/recover`.
- **Telegram bot (optional).** Finished / failed / waiting-for-approval notifications, Allow / Deny buttons, reply to a notification to continue that conversation (text or photo), start a new task from the phone, `/list`, `/status`, `/digest`, `/evening`, `/recover`, `/routines`. Images and PDFs a turn produces are sent along with the done message.
- **Routines.** Recurring prompts on a cron schedule. They never run unattended: at the due time you get a Telegram message with Run / Skip buttons, and the run starts on your tap (or with "Run now" in the web sidebar).
- **Daily digests** at 08:00 and 21:00: quota per seat, stuck conversations, what finished, errors in the server log, today's routines.
- **Phone-friendly, installable (PWA).** Works over Tailscale with Basic auth; with `tailscale serve` you get HTTPS and can install it as an app.
- **Handy extras.** Image attachments, per-seat 5-hour usage bar, context meter with Compact, archive / delete / rename, file previews of paths a reply mentions, "needs your answer" marks, pins and reply suggestions, gzip retention for old logs, `send.ps1` / `get.ps1` for scripting.
- **Zero npm dependencies.** Plain Node.js modules and static files. No build step.

## Requirements

Stated honestly, as tested:

- **Windows.** Developed and tested on Windows 11 only. The server uses `powershell.exe`, Windows process lookup, junctions and the Task Scheduler. It will not run on macOS or Linux without porting work.
- **Node.js 24** (tested with 24.16). Older versions are untested.
- **Windows PowerShell 5.1** (built into Windows).
- **Python 3** on `PATH` as `python` (a tiny helper copies MCP and trust settings into each seat's config).
- **Claude Code CLI**, installed by you (native installer at `%USERPROFILE%\.local\bin\claude.exe`, or the npm global package) and **signed in by you**, once per seat. Seat Console never asks for or handles your credentials; the CLI keeps them in the seat's own config folder.
- Optional: **Tailscale** (phone access), a **Telegram** bot token (notifications and control).

## Install

```powershell
git clone https://github.com/<you>/seat-console.git
cd seat-console
copy seats.example.json seats.json
notepad seats.json
```

There is nothing to `npm install`.

## Configure

### `seats.json`

```json
{
  "projectsDir": "C:/Users/you/projects",
  "seats": {
    "dev": { "email": "dev-account@example.com", "role": "Application code: features, bug fixes, tests" },
    "ops": { "email": "ops-account@example.com", "role": "Operations: scripts, automation, infrastructure" }
  }
}
```

- `seats`: one entry per Claude account. The key is the seat name (used in the UI, in Telegram commands like `/dev`, and as the folder name). `email` is only a label so you know which account the seat should be signed in to. `role` is added to the seat's system prompt as its area of work.
- `projectsDir`: the default working folder for new conversations, and the root that file previews may read from. It must exist.

Each seat gets its own config folder at `%USERPROFILE%\.claude-seats\<seat>`. Its `agents`, `commands`, `hooks`, `plugins`, `projects` and `skills` folders are junctions to your main `%USERPROFILE%\.claude`, its `CLAUDE.md` imports the main one, and `settings.json` is copied in on every start. Only the sign-in stays per seat.

### Time zone

Digests and routine schedules use one wall clock, `Europe/Vienna` by default. Set yours once, then restart the console:

```powershell
setx SEAT_CONSOLE_TZ "America/New_York"
```

### Routines (optional)

```powershell
copy console\routines.example.json console\routines.json
```

Each entry: `id`, `prompt` (inline text) or `promptFile` (a Markdown file; YAML front matter is stripped), `cron` (5 fields), `seat`, `cwd`, `enabled`, `mode` (`auto`), and optional `model` / `effort`. The file is re-read when it changes, so no restart is needed.

## Sign in each seat

Run this once per seat in a normal PowerShell window. A browser opens: sign in with the account you want for that seat.

```powershell
powershell -ExecutionPolicy Bypass -File .\seat.ps1 dev -Login
powershell -ExecutionPolicy Bypass -File .\seat.ps1 -Status
```

Tip: the browser signs in with whatever Claude account it is already logged in to. Use a private window per seat and close all private windows before the next seat.

You can also open a seat as a normal interactive terminal session: `.\seat.ps1 dev`.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File .\console\start-console.ps1
```

This starts the server and opens `http://127.0.0.1:4850`. It is idempotent: if the console is already running, it only opens the browser.

Start automatically at logon, with a supervisor that restarts the server after any exit (also creates Start Menu and Desktop shortcuts, including "Seat Console - Recover"):

```powershell
powershell -ExecutionPolicy Bypass -File .\console\install-autostart.ps1
```

Stop for good: `Stop-ScheduledTask 'Seat Console'`, then stop whatever still listens on port 4850.

After a crash: `powershell -ExecutionPolicy Bypass -File .\recover.ps1` lists interrupted conversations and resumes each one (`-DryRun` only lists).

### Files the console writes

All of these are gitignored: `console\state.json`, `console\logs\` (one JSONL per conversation), `console\uploads\`, `console\token.txt` (CSRF token for every POST), `console\server.log`, `console\supervisor.log`. Two secret files live outside the repo, in `%USERPROFILE%\.claude\secrets\`:

- `seat-console-auth.json`: user name and a random password for remote (non-loopback) access. Created on first start.
- `seat-console-telegram.json`: your bot token and linked chat id (see below).

## Telegram setup

1. In Telegram, open @BotFather, send `/newbot` and copy the token.
2. Create `%USERPROFILE%\.claude\secrets\seat-console-telegram.json`:
   ```json
   { "botToken": "PASTE-THE-TOKEN-HERE", "chatId": "" }
   ```
   and replace the placeholder with your token. Never commit this file.
3. Start (or restart) the console. While `chatId` is empty, it writes a one-time code to `console\telegram-link-code.txt` and to the server log (`telegram: send /start <code> to link`).
4. Send `/start <code>` to your bot. Only that exact message links the chat, so a stranger who finds your bot cannot take it over. The console then saves the `chatId` and deletes the code file.

Send `/help` to the bot for the command list. Reply to any notification to continue that conversation. To move the bot to another chat, clear `chatId` and restart.

## Phone access via Tailscale

The console listens on `127.0.0.1:4850` and, when Tailscale is running, also on your PC's Tailscale IPv4 address. It never listens on `0.0.0.0`. Every request that does not come from the PC itself must pass Basic auth (user and password from `seat-console-auth.json`).

1. Install Tailscale on the PC and on the phone, signed in to the same tailnet.
2. On the phone, open `http://<pc-tailscale-ip>:4850` (find the IP with `tailscale ip -4`) and log in.

To install it as an app, the phone needs HTTPS, which `tailscale serve` provides inside your tailnet only (no Funnel, so it is not on the public internet):

1. In the Tailscale admin console, under DNS, enable MagicDNS and HTTPS certificates.
2. On the PC: `tailscale serve --bg --https=443 http://127.0.0.1:4850`
3. On the phone, open `https://<pc-name>.<your-tailnet>.ts.net`, log in once, then use the browser menu: Install app.

Undo with `tailscale serve reset`. Requests that come in through `tailscale serve` are treated as remote and need Basic auth, even though they reach the server from loopback.

## Scripting

```powershell
.\console\send.ps1 -Seat ops -TextFile task.txt [-Model <model-id>] [-Mode auto|ask|bypass] [-Cwd <dir>] [-Conversation <id>] [-Wait]
.\console\get.ps1 -Conversation <id> [-Wait]
```

`send.ps1` prints `conversationId: <id>`; without `-Conversation` it starts a new conversation. Put the text in a UTF-8 file.

## Tests

Offline tests, no Claude account or quota needed:

```powershell
$env:TZ = 'Europe/Vienna'   # one routine test assumes the local clock is the default SEAT_CONSOLE_TZ
Get-ChildItem console\test-*.mjs | ForEach-Object { node $_.FullName; if ($LASTEXITCODE) { "FAILED: $($_.Name)" } }
```

`console\smoke.ps1` is an end-to-end test on a separate test instance (port 4851). **It uses a real seat named `ops` and spends real quota** (small model), so run it only when you mean to. `console\start-test.ps1` / `stop-test.ps1` start and stop that isolated test instance (own data folder, no Tailscale, Telegram off).

## Security

See [SECURITY.md](SECURITY.md). In short: loopback plus Tailscale only, Basic auth for anything remote, a CSRF token on every POST, Host and Origin checks, and file previews limited to `projectsDir` and the conversation's folder, never secret-looking files. `bypass` mode lets the CLI run tools without asking: use it only where you would run the CLI that way yourself.

## License

Apache License 2.0, see [LICENSE](LICENSE).
