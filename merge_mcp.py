# Copy the shared parts of the main ~/.claude.json into a seat's .claude.json,
# leaving the seat's own account fields (oauthAccount etc.) untouched:
#  - user-scope mcpServers
#  - onboarding flags, or an interactive seat re-runs the theme/login wizard
#    even though it is already logged in (hit on dev, 2026-10-13)
#  - per-folder trust, so a seat does not ask "trust this folder?" again
import json, os, sys

src, dst = sys.argv[1], sys.argv[2]
main = {}
if os.path.exists(src):   # no main ~/.claude.json yet (only seats are used): nothing to share
    with open(src, encoding="utf-8") as f:
        main = json.load(f)
seat = {}
if os.path.exists(dst):
    with open(dst, encoding="utf-8") as f:
        seat = json.load(f)

seat["mcpServers"] = main.get("mcpServers", {})
for key in ("hasCompletedOnboarding", "lastOnboardingVersion"):
    if key in main:
        seat[key] = main[key]
projects = seat.setdefault("projects", {})
for path, cfg in main.get("projects", {}).items():
    if cfg.get("hasTrustDialogAccepted"):
        projects.setdefault(path, {})["hasTrustDialogAccepted"] = True

with open(dst, "w", encoding="utf-8") as f:
    json.dump(seat, f, indent=2, ensure_ascii=False)
