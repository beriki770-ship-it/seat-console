[English](README.md) · [עברית](README.he.md) · **Español** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Deutsch](README.de.md)

# Seat Console

**Una consola web para todas tus cuentas de agentes de código.** Ejecuta sesiones de Claude Code, Codex y Antigravity CLI una junto a otra, una por cuenta, desde una pestaña del navegador o desde el móvil. Autoalojada, sin dependencias de npm.

![Seat Console](docs/media/seat-console-tour.gif)

<sub>Instancia de demostración con un CLI falso y datos inventados.</sub>

## Funciones

- **Puestos:** una barra lateral para todas las cuentas; puestos de Claude Code, Codex y Antigravity; menú de modelos por puesto.
- **Resiste reinicios:** cada conversación corre en su propio proceso en segundo plano; el servidor se reconecta tras un reinicio y, tras un fallo del PC, ofrece reanudar.
- **Aprobaciones:** modos `auto`, `ask` (tarjetas Permitir / Denegar) y `bypass` por conversación.
- **Medidores de uso:** ventana de 5 horas y semanal por puesto, hora de reinicio, aviso al 90 %; se espera al reinicio, nunca se cambia de cuenta.
- **Móvil:** PWA instalable vía Tailscale y bot de Telegram con botones, respuestas, fotos y archivos.
- **Proyectos multilado:** un brief, varios puestos, dependencias y una integración final.
- **15 idiomas** en la página y el bot, hebreo y árabe de derecha a izquierda.

**Regla fija:** cada puesto pertenece a una cuenta. Un puesto en su límite espera al reinicio; el trabajo nunca se pasa a otra cuenta para esquivar un límite.

## Inicio rápido

**Pruébala en un minuto, sin cuenta.** Esto inicia una instancia de prueba aparte con un CLI falso que repite lo que envías (Node.js 22+):

```sh
git clone https://github.com/beriki770-ship-it/seat-console.git && cd seat-console
cp seats.example.json seats.json && sed -i.bak "s#C:/Users/you/projects#$HOME#" seats.json
node console/server.mjs --port 4852 --data /tmp/seat-console-try --claude console/fixtures/fake-claude.mjs
```

Abre <http://127.0.0.1:4852> y envía un mensaje a un puesto. En Windows (PowerShell):

```powershell
git clone https://github.com/beriki770-ship-it/seat-console.git; cd seat-console
(Get-Content seats.example.json) -replace 'C:/Users/you/projects', ($HOME -replace '\\', '/') | Set-Content seats.json
node console\server.mjs --port 4852 --data "$env:TEMP\seat-console-try" --claude console\fixtures\fake-claude.mjs
```

**Uso real:** edita `seats.json` (una entrada por cuenta), inicia sesión una vez en cada puesto y arranca la consola:

```sh
sh seat.sh dev --login
sh console/start-console.sh
```

La guía completa, las preguntas frecuentes y el aviso legal están en el [README en inglés](README.md).
