# Contributing

Thanks for helping. A few ground rules keep the project small and safe:

- **No npm dependencies.** The console runs on plain Node.js modules. A change that needs a package has to explain why the standard library cannot do it.
- **Run the offline tests** before you open a pull request. They need no Claude account and spend no quota:
  ```powershell
  $env:TZ = 'Europe/Vienna'   # one routine test assumes the local clock is the default SEAT_CONSOLE_TZ
  Get-ChildItem console\test-*.mjs | ForEach-Object { node $_.FullName; if ($LASTEXITCODE) { "FAILED: $($_.Name)" } }
  ```
- **Test against the test instance**, never your everyday console: `console\start-test.ps1` starts one on port 4851 with its own data folder, no Tailscale and Telegram off. `console\smoke.ps1` runs the end-to-end check there, but it uses a real seat and real quota.
- **Never commit runtime data or secrets**: `seats.json`, `console\state.json`, `console\logs\`, `console\token.txt`, uploads, or anything from `%USERPROFILE%\.claude\secrets`. The `.gitignore` covers them; check `git status` anyway.
- Keep pull requests focused on one change, and say in the description how you tested it.

Security problems go through private reporting, see [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the Apache License 2.0.
