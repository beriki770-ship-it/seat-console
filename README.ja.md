[English](README.md) · [עברית](README.he.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · **日本語** · [Português (Brasil)](README.pt-BR.md) · [Deutsch](README.de.md)

# Seat Console

**コーディングエージェントの全アカウントを 1 つの Web コンソールで。** Claude Code、Codex、Antigravity CLI のセッションをアカウントごとに並べて、ブラウザのタブやスマートフォンから操作できます。セルフホスト、npm 依存なし。

![Seat Console](docs/media/seat-console-tour.gif)

<sub>偽の CLI と架空のデータで動かしたデモです。</sub>

## 機能

- **シート：** すべてのアカウントを 1 つのサイドバーに。Claude Code、Codex、Antigravity のシート、シートごとのモデル選択。
- **再起動に強い：** 各会話は独立したバックグラウンドプロセスで動作。サーバー再起動後は自動で再接続し、PC がクラッシュした後は再開を提案します。
- **承認：** 会話ごとに `auto`、`ask`（許可 / 拒否カード）、`bypass` モード。
- **使用量メーター：** シートごとに 5 時間枠と週間枠、リセット時刻、90 % で警告。上限に達したらリセットを待ち、別アカウントには切り替えません。
- **スマートフォン：** Tailscale 経由でインストールできる PWA、ボタン・返信・写真・ファイルに対応した Telegram ボット。
- **マルチサイドプロジェクト：** 1 つのブリーフを複数のシートで分担。依存関係と最後の統合まで。
- **15 言語**（ページとボット）。ヘブライ語とアラビア語は右から左に表示。

**固定ルール：** 各シートは 1 つのアカウントに属します。上限に達したシートはリセットを待ち、上限を避けるために作業を別アカウントへ移すことはありません。

## クイックスタート

**アカウントなしで 1 分で試せます。** 送った内容をそのまま返す偽の CLI で、別のテストインスタンスを起動します（Node.js 22 以上）：

```sh
git clone https://github.com/beriki770-ship-it/seat-console.git && cd seat-console
cp seats.example.json seats.json && sed -i.bak "s#C:/Users/you/projects#$HOME#" seats.json
node console/server.mjs --port 4852 --data /tmp/seat-console-try --claude console/fixtures/fake-claude.mjs
```

<http://127.0.0.1:4852> を開いて、シートにメッセージを送ってください。Windows（PowerShell）の場合：

```powershell
git clone https://github.com/beriki770-ship-it/seat-console.git; cd seat-console
(Get-Content seats.example.json) -replace 'C:/Users/you/projects', ($HOME -replace '\\', '/') | Set-Content seats.json
node console\server.mjs --port 4852 --data "$env:TEMP\seat-console-try" --claude console\fixtures\fake-claude.mjs
```

**本番利用：** `seats.json` を編集し（アカウントごとに 1 項目）、各シートで一度ログインしてからコンソールを起動します：

```sh
sh seat.sh dev --login
sh console/start-console.sh
```

詳しい手順、FAQ、免責事項は[英語の README](README.md) にあります。
