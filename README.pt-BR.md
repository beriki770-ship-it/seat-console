[English](README.md) · [עברית](README.he.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **Português (Brasil)** · [Deutsch](README.de.md)

# Seat Console

**Um console web para todas as suas contas de agentes de código.** Rode sessões do Claude Code, Codex e Antigravity CLI lado a lado, uma por conta, numa aba do navegador ou no celular. Auto-hospedado, sem dependências npm.

![Seat Console](docs/media/seat-console-tour.gif)

<sub>Instância de demonstração com um CLI falso e dados inventados.</sub>

## Recursos

- **Assentos:** uma barra lateral para todas as contas; assentos de Claude Code, Codex e Antigravity; menu de modelos por assento.
- **Resiste a reinícios:** cada conversa roda no próprio processo em segundo plano; o servidor se reconecta depois de reiniciar e, após uma queda do PC, oferece retomar.
- **Aprovações:** modos `auto`, `ask` (cartões Permitir / Negar) e `bypass` por conversa.
- **Medidores de uso:** janela de 5 horas e semanal por assento, horário de reset, aviso em 90 %; espera o reset, nunca troca de conta.
- **Celular:** PWA instalável via Tailscale e bot do Telegram com botões, respostas, fotos e arquivos.
- **Projetos multilaterais:** um briefing, vários assentos, dependências e uma integração final.
- **15 idiomas** na página e no bot, hebraico e árabe da direita para a esquerda.

**Regra fixa:** cada assento pertence a uma conta. Um assento no limite espera o reset; o trabalho nunca vai para outra conta para driblar um limite.

## Início rápido

**Experimente em um minuto, sem conta.** Isto inicia uma instância de teste separada com um CLI falso que devolve o que você envia (Node.js 22+):

```sh
git clone https://github.com/beriki770-ship-it/seat-console.git && cd seat-console
cp seats.example.json seats.json && sed -i.bak "s#C:/Users/you/projects#$HOME#" seats.json
node console/server.mjs --port 4852 --data /tmp/seat-console-try --claude console/fixtures/fake-claude.mjs
```

Abra <http://127.0.0.1:4852> e envie uma mensagem para um assento. No Windows (PowerShell):

```powershell
git clone https://github.com/beriki770-ship-it/seat-console.git; cd seat-console
(Get-Content seats.example.json) -replace 'C:/Users/you/projects', ($HOME -replace '\\', '/') | Set-Content seats.json
node console\server.mjs --port 4852 --data "$env:TEMP\seat-console-try" --claude console\fixtures\fake-claude.mjs
```

**Uso real:** edite `seats.json` (uma entrada por conta), faça login uma vez em cada assento e inicie o console:

```sh
sh seat.sh dev --login
sh console/start-console.sh
```

O guia completo, as perguntas frequentes e o aviso legal estão no [README em inglês](README.md).
