[English](README.md) · [עברית](README.he.md) · [Español](README.es.md) · **简体中文** · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Deutsch](README.de.md)

# Seat Console

**一个网页控制台，管理你所有的编码智能体账号。** 在浏览器标签页或手机上并排运行 Claude Code、Codex 和 Antigravity CLI 会话，每个账号一个。自托管，无 npm 依赖。

![Seat Console](docs/media/seat-console-tour.gif)

<sub>演示实例：使用模拟 CLI 和虚构数据。</sub>

## 功能

- **席位：** 一个侧边栏列出所有账号；支持 Claude Code、Codex 和 Antigravity 席位；每个席位有自己的模型菜单。
- **重启不丢失：** 每个对话在独立的后台进程中运行；服务器重启后自动重新连接，电脑崩溃后提示恢复。
- **审批：** 每个对话可选 `auto`、`ask`（允许 / 拒绝卡片）和 `bypass` 模式。
- **用量计量：** 每个席位显示 5 小时和每周窗口、重置时间，90 % 时提醒；等待重置，绝不切换到其他账号。
- **手机：** 通过 Tailscale 安装为 PWA，Telegram 机器人支持按钮、回复、照片和文件。
- **多方项目：** 一份需求，多个席位，处理依赖关系，最后统一集成。
- **15 种语言**（页面和机器人），希伯来语和阿拉伯语从右到左显示。

**固定规则：** 每个席位属于一个账号。达到用量上限的席位会等待重置，工作绝不会转到其他账号来绕过限制。

## 快速开始

**一分钟试用，无需账号。** 以下命令会启动一个独立的测试实例，使用一个回显你所发消息的模拟 CLI（需要 Node.js 22+）：

```sh
git clone https://github.com/beriki770-ship-it/seat-console.git && cd seat-console
cp seats.example.json seats.json && sed -i.bak "s#C:/Users/you/projects#$HOME#" seats.json
node console/server.mjs --port 4852 --data /tmp/seat-console-try --claude console/fixtures/fake-claude.mjs
```

打开 <http://127.0.0.1:4852>，给某个席位发一条消息。Windows（PowerShell）：

```powershell
git clone https://github.com/beriki770-ship-it/seat-console.git; cd seat-console
(Get-Content seats.example.json) -replace 'C:/Users/you/projects', ($HOME -replace '\\', '/') | Set-Content seats.json
node console\server.mjs --port 4852 --data "$env:TEMP\seat-console-try" --claude console\fixtures\fake-claude.mjs
```

**正式使用：** 编辑 `seats.json`（每个账号一项），每个席位登录一次，然后启动控制台：

```sh
sh seat.sh dev --login
sh console/start-console.sh
```

完整指南、常见问题和免责声明见[英文 README](README.md)。
