[English](README.md) · [עברית](README.he.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · **Deutsch**

# Seat Console

**Eine Web-Konsole für alle deine Coding-Agent-Konten.** Claude Code-, Codex- und Antigravity-CLI-Sitzungen nebeneinander, eine pro Konto, aus einem Browser-Tab oder vom Handy. Selbst gehostet, ohne npm-Abhängigkeiten.

![Seat Console](docs/media/seat-console-tour.gif)

<sub>Demo-Instanz mit einer Fake-CLI und erfundenen Daten.</sub>

## Funktionen

- **Seats:** eine Seitenleiste für alle Konten; Claude Code-, Codex- und Antigravity-Seats; Modellmenü pro Seat.
- **Neustartfest:** Jede Unterhaltung läuft in einem eigenen Hintergrundprozess; der Server verbindet sich nach einem Neustart wieder, nach einem PC-Absturz bietet er die Fortsetzung an.
- **Freigaben:** Modi `auto`, `ask` (Karten Erlauben / Ablehnen) und `bypass` pro Unterhaltung.
- **Nutzungsanzeigen:** 5-Stunden- und Wochenfenster pro Seat, Reset-Zeit, Warnung bei 90 %; es wird auf den Reset gewartet, nie auf ein anderes Konto ausgewichen.
- **Handy:** installierbare PWA über Tailscale und ein Telegram-Bot mit Buttons, Antworten, Fotos und Dateien.
- **Mehrseitige Projekte:** ein Briefing, mehrere Seats, Abhängigkeiten und eine abschließende Integration.
- **15 Sprachen** für Seite und Bot, Hebräisch und Arabisch von rechts nach links.

**Feste Regel:** Jeder Seat gehört zu einem Konto. Ein Seat am Limit wartet auf den Reset; Arbeit wird nie auf ein anderes Konto verschoben, um ein Limit zu umgehen.

## Schnellstart

**In einer Minute ausprobieren, ohne Konto.** Das startet eine separate Testinstanz mit einer Fake-CLI, die zurückgibt, was du schickst (Node.js 22+):

```sh
git clone https://github.com/beriki770-ship-it/seat-console.git && cd seat-console
cp seats.example.json seats.json && sed -i.bak "s#C:/Users/you/projects#$HOME#" seats.json
node console/server.mjs --port 4852 --data /tmp/seat-console-try --claude console/fixtures/fake-claude.mjs
```

Öffne <http://127.0.0.1:4852> und schicke einem Seat eine Nachricht. Unter Windows (PowerShell):

```powershell
git clone https://github.com/beriki770-ship-it/seat-console.git; cd seat-console
(Get-Content seats.example.json) -replace 'C:/Users/you/projects', ($HOME -replace '\\', '/') | Set-Content seats.json
node console\server.mjs --port 4852 --data "$env:TEMP\seat-console-try" --claude console\fixtures\fake-claude.mjs
```

**Echter Einsatz:** `seats.json` bearbeiten (ein Eintrag pro Konto), jeden Seat einmal anmelden und die Konsole starten:

```sh
sh seat.sh dev --login
sh console/start-console.sh
```

Die vollständige Anleitung, die FAQ und der Haftungshinweis stehen im [englischen README](README.md).
