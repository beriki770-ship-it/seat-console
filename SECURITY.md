# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include what you found, how to reproduce it, and which version (commit) you tested. You will get an answer as soon as the maintainer can look at it.

## What Seat Console is designed to protect

- The console listens on `127.0.0.1` and on the Tailscale IPv4 address only, never on all interfaces.
- Every request that does not come from the PC itself needs Basic auth. Requests that arrive through a proxy such as `tailscale serve` count as remote.
- Every POST needs the CSRF token, and Host and Origin headers are checked against an allowlist.
- File previews are limited to `projectsDir` and the conversation's working folder, and refuse the console's own folder, `.claude` folders and secret-looking names.
- Secrets (the Basic-auth password, the Telegram bot token) live outside the repository and are never logged.

## Out of scope

- Anything the Claude Code CLI itself does with the tools you allow it, in particular in `bypass` mode.
- Attacks by someone who already controls your Windows user account or your tailnet.
