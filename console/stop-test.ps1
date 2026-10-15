# Stops the TEST instance (port 4851 only; production 4850 is never touched by this script).
Get-NetTCPConnection -LocalPort 4851 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
"test instance stopped"
