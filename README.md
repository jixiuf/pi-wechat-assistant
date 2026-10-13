<h1 align="center">pi-wechat-assistant</h1>

<p align="center">
  <strong>A personal WeChat assistant for pi TUI</strong><br>
  Turn WeChat into your mobile remote for a single pi session.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-wechat-assistant"><img src="https://img.shields.io/npm/v/pi-wechat-assistant?color=blue" alt="npm"></a>
  <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.3-339933" alt="Node">
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#中文">中文</a> · <a href="#日本語">日本語</a> · <a href="#한국어">한국어</a>
</p>

---

<a id="english"></a>

## What is this?

**pi-wechat-assistant** is a [pi](https://github.com/earendil-works/pi-coding-agent) extension that connects **one WeChat user** to **one pi TUI session**. It is not a generic chatbot bridge or a multi-session orchestrator — it is a personal assistant that lets you continue your pi conversation from WeChat when you step away from your computer.

Messages you send on WeChat are injected into the active pi session; AI replies are sent back to WeChat. Messages you type in TUI are also previewed on WeChat, keeping both sides in sync.

> **One WeChat user ↔ One pi TUI session.** That's the whole scope.

## Features

- 📱 **Personal assistant** — designed for a single user continuing a single pi session from WeChat
- 🔐 **QR code login** — scan with WeChat to authorize
- 🔄 **Two-way sync** — WeChat ↔ TUI messages are visible on both sides
- 🖼️ **Image support** — download, decrypt, and send images to the model for analysis
- 📁 **File support** — receive files from WeChat, save to project directory; send project files back
- 🗣️ **Voice support** — uses WeChat's built-in speech-to-text
- 💬 **Message queuing & batching** — consecutive messages are merged; multiple images wait for a text supplement
- 🔒 **Exclusive lock** — only one TUI session can hold the WeChat connection at a time
- 📊 **Status bar** — shows WeChat connection status and pending message count in TUI

## Quick Start

### Install

```bash
pi install npm:pi-wechat-assistant
```

Or from GitHub:

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### Usage

In the pi TUI:

```
/wechat login
/wechat start
```

Then open WeChat, find the bot, and start messaging.

Login credentials are shared account configuration and survive session restarts. Normally, run only `/wechat start` and `/wechat stop` in each session. `login --force` is an explicit recovery command; it is never invoked automatically. `logout` clears local credentials and context, rather than revoking the binding on the WeChat server.

Use `/wechat config` for common settings, advanced image/tool options, and reply-template actions. Existing commands remain available. See [settings and defaults](docs/settings.md).

Two-way synchronization is enabled by default: new TUI user messages and AI replies are forwarded to the bound WeChat user. Use `/wechat config bidirectional off` to forward only replies to WeChat-triggered tasks, or `on` to restore two-way sync. Existing conversation history is not replayed.

`/wechat login` auto-starts the bridge in the current session after a successful login. After local startup checks, `/wechat start` offers cooperative handoff when the live owner advertises support: it requests a stop, waits up to 30 seconds for the old poller and in-flight sends to finish and release ownership, then acquires the lock exclusively. It does not cancel the old session’s AI task. Legacy owners (including 0.4.3), non-interactive starts, uncertain ownership, and timeouts require manual `/wechat stop` in the owning session; they never force takeover. A cancelled request cannot undo a stop the owner has already begun. The bridge restores cached reply context and sends the official startup/shutdown notifications. It attempts delivery even without cached context; if a contextual send is rejected with `ret=-2`, it retries once without context. This fallback does not guarantee delivery when WeChat requires fresh user activity: a persistent `ret=-2` rejection raises a one-time warning suggesting to send a message from WeChat first, `/wechat status` explains the remedy, and the footer keeps showing `发送失败` until a send succeeds. `/wechat status` distinguishes polling state, cached context, and the most recent send API result; cached context does not prove validity, and API success is not a read receipt.

The compact footer wraps standard Unicode glyphs in brackets — a green `微信` label, `⇄` while two-way sync is enabled, and green `▶` / red `⏸` for running / stopped — so every terminal renders them at a consistent size without Nerd Fonts. The `微信` label uses WeChat green (`#07C160`) on truecolor terminals and white otherwise; running / stopped indicators use green / red (standard ANSI colors on non-truecolor terminals); `NO_COLOR` disables all styling. Queue counts and send failures appear only when relevant; credentials and successful-send diagnostics remain in `/wechat status`.

## TUI Commands

All commands use `/wechat` with a subcommand:

| Command | Description |
| --- | --- |
| `/wechat login` | Scan QR code to log in (auto-starts the bridge) |
| `/wechat login --force` | Force re-scan |
| `/wechat start` | Start the WeChat connection |
| `/wechat stop` | Stop and release the lock |
| `/wechat status` | Show connection status and config |
| `/wechat config` | Open interactive settings (text output without UI) |
| `/wechat config show` | Show settings as text |
| `/wechat config source on\|off` | Toggle WeChat source and reply rules (default **on**) |
| `/wechat prompt show` | View the reply template and override path |
| `/wechat prompt init` | Export the default template without overwriting a user file |
| `/wechat prompt reload` | Load edited rules for future WeChat submissions |
| `/wechat config image-wait <ms>` | Set batch wait time (default `8000`) |
| `/wechat config image-max <MB>` | Set per-image size limit (default `50`) |
| `/wechat autostart` | Toggle auto-start on session begin |
| `/wechat remotetools` | Toggle WeChat-side `/tools` command (default **off**) |
| `/wechat logout` | Clear credentials and stop |

The source feature (on by default) marks each new WeChat batch with `[微信]`, while the user-editable reply template lives in one fixed conditional system-prompt section appended to every run while the bridge runs. Installing without starting the bridge registers no sending tools. Replies retain full URLs and send code in separate, lossless chunks. See [source rules, templates, formatting, and compatibility](docs/wechat-source.md).

## WeChat Remote Commands

Send text, voice, or images on WeChat to chat normally. Additional commands:

| Command | Description |
| --- | --- |
| `/status` | Model, context usage, queue, config |
| `/stop` | Abort current generation |
| `/model` | List available models |
| `/model <name>` | Switch model |
| `/config` | View image config |
| `/name <name>` | Set session name |
| `/session` | Show session details |
| `/help` | Show help |

Advanced: `/thinking`, `/compact`. WeChat-side `/tools` is **disabled by default** (it can change local tool permissions); enable it in the TUI with `/wechat remotetools on`.

## Supported Message Types

| Type | Status |
| --- | --- |
| Text | ✅ |
| Voice | ✅ (WeChat speech-to-text) |
| Image | ✅ (downloaded and sent to model) |
| Quote reply | ✅ (quoted text prepended) |
| File | ✅ (saved to project directory) |
| Video | ❌ Not supported |

## Configuration

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PI_WECHAT_DEBUG` | Set to `1` to enable debug logging | Off |
| `PI_WECHAT_DEBUG_FILE` | Debug log file path | `~/.pi/agent/wechat-assistant/debug.log` |
| `PI_WECHAT_IMAGE_BATCH_WAIT_MS` | Batch wait time for images | `8000` |
| `PI_WECHAT_IMAGE_MAX_BYTES` | Per-image size limit | `52428800` (50 MB) |

### Config Files

```
~/.pi/agent/wechat-assistant/
├── credentials.json    # Login credentials (mode 600)
├── config.json         # Auto-start, remote tools, image limits (mode 600)
├── wechat-prompt.md     # Optional user reply template
├── context-tokens.json # Reply context for the bound user (mode 600)
├── cursor.json         # Long-poll cursor (mode 600)
├── seen-ids.json       # Recent message IDs for deduplication (mode 600)
└── session.lock        # Exclusive lock file (mode 600)
```

The state directory itself is restricted to mode `700`.

`config.json` example:

```json
{
  "autoStart": true,
  "imageBatchWaitMs": 8000,
  "imageMaxBytes": 52428800
}
```

## Architecture

```
WeChat  ⇄  pi TUI session  ⇄  AI model + tools
```

- WeChat messages are fetched via iLink Bot API long polling
- Only the WeChat user ID bound during QR login is accepted; messages from other users are ignored
- Incoming messages are injected into the active pi session via `pi.sendUserMessage()`
- When you type in TUI, a preview is sent to WeChat
- AI replies are delivered incrementally (per `message_end`); the `agent_end` catch-up replay was removed to prevent duplicate historical messages after session restore
- Only the TUI session that runs `/wechat start` holds the connection

## FAQ

**Stale mutex warning?** A process crash during a lock update can leave `session.lock.mutex`. The extension refuses to guess ownership. Close all pi bridge processes using this account and confirm none is running before manually removing that file and restarting; do not delete locks while a bridge is running.

**WeChat not responding?** Run `/wechat status` to check. If the session expired, run `/wechat login --force`.

**"Already occupied by another pi instance"?** Another TUI session holds the lock. Run `/wechat stop` in that session.

**Why aren't images processed immediately?** Images wait up to 8 seconds for batching — so you can send multiple images and add a text description. The first image gets an acknowledgment immediately; if you send text during the wait, processing starts right away.

## Development

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install
npm run typecheck
npm run typecheck:pi  # Published Pi APIs: 0.73.1, 0.78.0, 0.99.2, 1.1.0, 1.2.0

# Quick test
pi -e ./src/index.ts
```

## Releasing

```bash
npm version patch   # updates package.json, commits, and tags
git push --follow-tags   # triggers CI → npm publish + GitHub Release
```

## License

[MIT](LICENSE)

---
---

<a id="中文"></a>

## 这是什么？

**pi-wechat-assistant** 是一个 [pi](https://github.com/earendil-works/pi-coding-agent) 扩展，将**一个微信用户**连接到**一个 pi TUI 会话**。它不是一个通用聊天机器人桥接，也不是多会话编排器——它是一个个人助手，让你离开电脑后可以通过微信继续和同一个 pi 会话交互。

你在微信里发的消息会被注入当前 pi 会话，AI 的回复会发回微信。你在 TUI 里输入的消息也会在微信端显示预览，保持两边同步。

> **一个微信用户 ↔ 一个 pi TUI 会话。** 这就是全部的定位。

## 特性

- 📱 **个人助手** — 为单用户远程操控单个 pi 会话设计
- 🔐 **扫码登录** — 微信扫码授权
- 🔄 **双向同步** — 微信 ↔ TUI 消息在两边都可见
- 🖼️ **图片支持** — 下载、解密、发送给模型分析
- 📁 **文件支持** — 从微信接收文件保存到项目目录；发送项目文件回微信
- 🗣️ **语音支持** — 使用微信内置语音转文字
- 💬 **消息排队与合并** — 连续消息自动合并；多张图片等待文字补充后一起处理
- 🔒 **排他锁** — 同一时间只有一个 TUI 会话持有微信连接
- 📊 **状态栏** — TUI 底部显示微信连接状态和待处理消息数

## 快速开始

### 安装

```bash
pi install npm:pi-wechat-assistant
```

或从 GitHub 安装：

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### 使用

在 pi TUI 中执行：

```
/wechat login
/wechat start
```

然后打开微信找到机器人，直接发消息即可。

登录凭证属于共享的账号配置，跨会话保存。日常在会话里只需 `/wechat start`、`/wechat stop`；`login --force` 仅用于手动恢复，不会自动调用。`logout` 清除本地凭证和上下文，不等于在微信服务端解绑。

执行 `/wechat config` 打开设置窗口，可修改常用设置、高级图片与工具选项，以及查看、导出、重载回复模板。原有命令继续可用。详见[配置项及默认值](docs/settings.md)。

双向同步默认开启：新的电脑端用户输入和 AI 回复会同步给扫码绑定用户。执行 `/wechat config bidirectional off` 后仅发送微信任务的回复；执行 `/wechat config bidirectional on` 恢复双向同步。不会重发历史会话内容。

`/wechat login` 登录成功后在当前会话自动启动桥接。`/wechat start` 先完成本地启动检查；若持锁会话支持交接协议，则弹窗确认后请求其停止，最多等待 30 秒，等旧轮询和进行中的发送结束并释放锁后再排他获取锁。不取消旧会话的 AI 任务。旧版（包括 0.4.3）、非交互启动、归属不明或超时都不会强行接管，需要在持锁会话手动 `/wechat stop`。取消请求不能撤销旧会话已经开始的停止操作。启动会恢复已保存的消息发送凭据（`context_token`），并调用官方上线通知；停止时调用下线通知。没有消息发送凭据也会尝试发送；携带该凭据发送被明确以 `ret=-2` 拒绝时，去掉该凭据重试一次。这个兜底不保证绕过微信侧需要新用户消息的限制：持续被 `ret=-2` 拒绝时会弹一次性警告，提示先从微信发送一条消息，`/wechat status` 也会说明补救方法，底部保持 `发送失败` 直到发送成功。`/wechat status` 分别显示登录凭据、轮询状态、消息发送凭据和最近发送接口结果：发送凭据已保存不代表仍有效，接口成功不代表已读。

底部以方括号包裹标准 Unicode 字形——绿色 `微信` 标签、`⇄`（仅双向同步开启时显示）及绿色 `▶` / 红色 `⏸`（运行 / 停止）——不依赖 Nerd Font，任何终端下尺寸一致。`微信` 标签在真彩色终端使用微信绿（`#07C160`），否则降级为白色；运行 / 停止图标分别为绿色 / 红色（非真彩色终端使用标准 ANSI 颜色）。设置 `NO_COLOR` 可关闭所有着色。只在有排队消息或发送失败时追加提示；凭据与成功发送详情留在 `/wechat status`。

## TUI 命令

| 命令 | 说明 |
| --- | --- |
| `/wechat login` | 扫码登录（成功后自动启动桥接） |
| `/wechat login --force` | 强制重新扫码 |
| `/wechat start` | 启动微信连接 |
| `/wechat stop` | 停止并释放锁 |
| `/wechat status` | 查看连接状态和配置 |
| `/wechat config` | 打开交互设置窗口（无 UI 时显示文本） |
| `/wechat config show` | 查看配置文本 |
| `/wechat config source on\|off` | 开关微信来源与回复约定（默认**开启**） |
| `/wechat prompt show` | 查看回复模板及用户覆盖路径 |
| `/wechat prompt init` | 导出默认模板，不覆盖已有用户文件 |
| `/wechat prompt reload` | 为后续新投递的微信消息加载新规则 |
| `/wechat config image-wait <ms>` | 设置图片批量等待时间，默认 `8000` |
| `/wechat config image-max <MB>` | 设置单张图片大小上限，默认 `50` |
| `/wechat autostart` | 开关自动启动 |
| `/wechat remotetools` | 开关微信端 `/tools` 命令（默认**关闭**） |
| `/wechat logout` | 清除凭证并停止 |

来源功能（默认开启）为每个新微信批次添加 `[微信]`，可编辑回复模板放在一段固定且条件化的系统提示词中，桥接运行期间每次任务都追加。仅安装而不启动桥接，不注册发送工具。微信回复保留完整链接，代码单独分块并保留原文。详见[来源约定、模板、排版和兼容设计](docs/wechat-source.md#中文)。

模型报错会自动通知微信；支持结束前边界的新版 Pi 等自动重试结束后确认失败再通知，0.84.x 仅保守提示“此前一次模型请求失败”，更旧版本提示本次请求失败且可能重试。不会根据正文关键词或历史消息判断失败。详见[错误通知与新旧版本边界](docs/model-errors.md#中文)。

## 微信远程命令

微信里直接发文字/语音/图片就是正常对话。额外命令：

| 命令 | 说明 |
| --- | --- |
| `/status` | 查看模型、上下文、队列、配置 |
| `/stop` | 停止当前生成 |
| `/model` | 查看可用模型 |
| `/model <名称>` | 切换模型 |
| `/config` | 查看图片配置 |
| `/name <名称>` | 设置会话名称 |
| `/session` | 查看会话详情 |
| `/help` | 显示帮助 |

高级命令：`/thinking`、`/compact`。微信端 `/tools` 默认**禁用**（它可修改本机工具权限），可在电脑端 TUI 执行 `/wechat remotetools on` 开启。

## 支持的消息类型

| 类型 | 状态 |
| --- | --- |
| 文字 | ✅ |
| 语音 | ✅（微信语音转文字） |
| 图片 | ✅（下载后发送给模型分析） |
| 引用回复 | ✅（拼接引用文本） |
| 文件 | ✅（保存到项目目录） |
| 视频 | ❌ 暂不支持 |

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PI_WECHAT_DEBUG` | 设为 `1` 开启调试日志 | 关闭 |
| `PI_WECHAT_DEBUG_FILE` | 调试日志路径 | `~/.pi/agent/wechat-assistant/debug.log` |
| `PI_WECHAT_IMAGE_BATCH_WAIT_MS` | 图片批量等待时间 | `8000` |
| `PI_WECHAT_IMAGE_MAX_BYTES` | 单张图片大小上限 | `52428800`（50 MB） |

### 配置文件

```
~/.pi/agent/wechat-assistant/
├── credentials.json    # 登录凭证（权限 600）
├── config.json         # 自动启动、远程工具、图片限制（权限 600）
├── wechat-prompt.md     # 可选的用户回复模板
├── context-tokens.json # 绑定用户的消息发送凭据（权限 600）
├── cursor.json         # 长轮询游标（权限 600）
├── seen-ids.json       # 去重用的近期消息 ID（权限 600）
└── session.lock        # 排他锁文件（权限 600）
```

状态目录本身的权限为 `700`。

## 架构

```
微信  ⇄  pi TUI 会话  ⇄  AI 模型 + 工具
```

- 微信消息通过 iLink Bot API 长轮询获取
- 只接受扫码登录时绑定的微信用户，其他用户的消息会被忽略
- 收到的消息通过 `pi.sendUserMessage()` 注入当前 pi 会话
- TUI 输入时微信端会收到预览
- AI 回复增量发送（每条 `message_end` 即发），不依赖 `agent_end` 补发（防止恢复会话后历史回复重发）
- 只有执行 `/wechat start` 的 TUI 会话持有连接

## 常见问题

**微信没有回复？** 执行 `/wechat status` 检查状态。Session 过期则执行 `/wechat login --force`。

**提示"已被其他 pi 实例占用"？** 新版会话支持通过 `/wechat start` 确认协作交接；旧版或交接超时，请先在持锁会话执行 `/wechat stop`。

**提示 mutex 未清理？** 锁更新期间进程异常退出可能留下 `session.lock.mutex`，扩展会拒绝继续抢锁。先关闭所有使用该账号的 pi 桥接进程，确认没有桥接在运行，再手动移除该文件并重新启动；不要在仍有桥接运行时删除锁。

**图片为什么不马上处理？** 图片默认等待 8 秒用于批量合并，方便你连发多张图再补描述。收到第一张图会立即回执，期间发文字则立即开始处理。

## 开发

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install
npm run typecheck
npm run typecheck:pi  # 检查 pi 0.73.1、0.78.0、0.99.2、1.1.0、1.2.0 的已发布 API

# 快速测试
pi -e ./src/index.ts
```

## 发版

```bash
npm version patch   # 更新 package.json、提交、打 tag
git push --follow-tags   # 触发 CI → npm 发布 + GitHub Release
```

## 许可证

[MIT](LICENSE)

---
---

<a id="日本語"></a>

## これは何？

**pi-wechat-assistant** は [pi](https://github.com/earendil-works/pi-coding-agent) の拡張機能で、**1人のWeChatユーザー**を**1つのpi TUIセッション**に接続します。汎用チャットボットブリジでも、マルチセッションオーケストレーターでもありません。パソコンから離れている間、WeChatから同じpiセッションの会話を続けるためのパーソナルアシスタントです。

WeChatで送信したメッセージは現在のpiセッションに注入され、AIの返信がWeChatに送り返されます。TUIで入力したメッセージもWeChat側にプレビューが表示され、両側を同期します。

> **1人のWeChatユーザー ↔ 1つのpi TUIセッション。** それがこのプロジェクトのスコープです。

## 特徴

- 📱 **パーソナルアシスタント** — 単一ユーザーが単一のpiセッションをWeChatからリモート操作するために設計
- 🔐 **QRコードログイン** — WeChatでスキャンして認証
- 🔄 **双方向同期** — WeChat ↔ TUIのメッセージが両側で閲覧可能
- 🖼️ **画像対応** — ダウンロード、復号、モデルに送信して分析
- 📁 **ファイル対応** — WeChatからファイルを受信してプロジェクトディレクトリに保存、プロジェクトファイルをWeChatに送信
- 🗣️ **音声対応** — WeChat内蔵の音声認識を利用
- 💬 **メッセージキューイング＆バッチ処理** — 連続メッセージの自動マージ、複数画像はテキスト補完を待ってから一括処理
- 🔒 **排他ロック** — 同時に1つのTUIセッションのみWeChat接続を保持
- 📊 **ステータスバー** — TUI下部にWeChat接続状態と保留メッセージ数を表示

## クイックスタート

### インストール

```bash
pi install npm:pi-wechat-assistant
```

またはGitHubから：

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### 使い方

pi TUIで以下を実行：

```
/wechat login
/wechat start
```

WeChatでボットを見つけて、メッセージを送るだけです。

## TUIコマンド

| コマンド | 説明 |
| --- | --- |
| `/wechat login` | QRコードをスキャンしてログイン |
| `/wechat login --force` | 強制的に再スキャン |
| `/wechat start` | WeChat接続を開始 |
| `/wechat stop` | 停止してロックを解放 |
| `/wechat status` | 接続状態と設定を表示 |
| `/wechat config` | 画像関連設定を表示 |
| `/wechat config source on\|off` | WeChatの送信元表示と返信ルールを切替（デフォルト無効） |
| `/wechat prompt show\|init\|reload` | 返信テンプレートの表示・作成・再読込 |
| `/wechat config image-wait <ms>` | バッチ待機時間を設定（デフォルト `8000`） |
| `/wechat config image-max <MB>` | 画像サイズ上限を設定（デフォルト `50`） |
| `/wechat autostart` | セッション開始時の自動起動を切替 |
| `/wechat remotetools` | WeChat 側 `/tools` コマンドの切替（デフォルト**無効**） |
| `/wechat logout` | 認証情報をクリアして停止 |

## WeChatリモートコマンド

WeChatでテキスト、音声、画像を送るだけで通常の会話になります。追加コマンド：

| コマンド | 説明 |
| --- | --- |
| `/status` | モデル、コンテキスト使用量、キュー、設定 |
| `/stop` | 現在の生成を中止 |
| `/model` | 利用可能なモデル一覧 |
| `/model <名前>` | モデル切替 |
| `/config` | 画像設定を表示 |
| `/name <名前>` | セッション名を設定 |
| `/session` | セッション詳細を表示 |
| `/help` | ヘルプを表示 |

上級者向け：`/thinking`、`/compact`。WeChat 側の `/tools` はデフォルトで**無効**です（ローカルのツール権限を変更できるため）。TUI で `/wechat remotetools on` を実行して有効化できます。

## 対応メッセージタイプ

| タイプ | 状態 |
| --- | --- |
| テキスト | ✅ |
| 音声 | ✅（WeChat音声認識） |
| 画像 | ✅（ダウンロード後モデルに送信） |
| 引用返信 | ✅（引用テキストを付加） |
| ファイル | ✅（プロジェクトディレクトリに保存） |
| 動画 | ❌ 未対応 |

## 設定

### 環境変数

| 変数 | 説明 | デフォルト |
| --- | --- | --- |
| `PI_WECHAT_DEBUG` | `1` でデバッグログ有効 | オフ |
| `PI_WECHAT_DEBUG_FILE` | デバッグログパス | `~/.pi/agent/wechat-assistant/debug.log` |
| `PI_WECHAT_IMAGE_BATCH_WAIT_MS` | 画像バッチ待機時間 | `8000` |
| `PI_WECHAT_IMAGE_MAX_BYTES` | 画像サイズ上限 | `52428800`（50 MB） |

### 設定ファイル

```
~/.pi/agent/wechat-assistant/
├── credentials.json    # ログイン認証情報（権限 600）
├── config.json         # 自動起動、リモートツール、画像制限（権限 600）
├── context-tokens.json # バインド済みユーザーの返信コンテキスト（権限 600）
├── cursor.json         # ロングポーリングカーソル（権限 600）
├── seen-ids.json       # 重複排除用の最近のメッセージID（権限 600）
└── session.lock        # 排他ロックファイル（権限 600）
```

状態ディレクトリ自体の権限は `700` です。

## アーキテクチャ

```
WeChat  ⇄  pi TUIセッション  ⇄  AIモデル + ツール
```

- WeChatメッセージはiLink Bot APIのロングポーリングで取得
- QRログインでバインドされたWeChatユーザーのみ受け付け、他のユーザーのメッセージは無視
- 受信メッセージは `pi.sendUserMessage()` で現在のpiセッションに注入
- TUIで入力するとWeChat側にプレビューが送信
- AI返信は増分的に送信（`message_end` ごと）、`agent_end` での補完は行わない（セッション復元後の過去返信重複送信を防止）
- `/wechat start` を実行したTUIセッションのみが接続を保持

## FAQ

**WeChatから返信がない？** `/wechat status` で状態を確認。セッション期限切れなら `/wechat login --force` を実行。

**「他のpiインスタンスが使用中」と表示？** 別のTUIセッションがロックを保持中。そのセッションで `/wechat stop` を実行。

**画像がすぐに処理されない？** バッチ処理のため最大8秒待機。複数画像を連続送信後、テキストで補足できます。最初の画像は即座に確認応答、待機中にテキストを送ると即時処理。

## 開発

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install
npm run typecheck

# クイックテスト
pi -e ./src/index.ts
```

## リリース

```bash
npm version patch   # package.jsonを更新、コミット、タグ作成
git push --follow-tags   # CI → npm公開 + GitHub Release をトリガー
```

## ライセンス

[MIT](LICENSE)

---
---

<a id="한국어"></a>

## 이것은 무엇인가요?

**pi-wechat-assistant**는 [pi](https://github.com/earendil-works/pi-coding-agent) 확장 기능으로, **1명의 WeChat 사용자**를 **1개의 pi TUI 세션**에 연결합니다. 범용 챗봇 브릿지도, 멀티 세션 오케스트레이터도 아닙니다. 컴퓨터를 떠나 있는 동안 WeChat에서 동일한 pi 세션 대화를 이어갈 수 있게 해주는 개인 어시스턴트입니다.

WeChat에서 보낸 메시지는 현재 pi 세션에 주입되고, AI 응답이 WeChat으로 돌아옵니다. TUI에서 입력한 메시지도 WeChat 측에 미리보기가 표시되어 양쪽을 동기화합니다.

> **1명의 WeChat 사용자 ↔ 1개의 pi TUI 세션.** 그것이 이 프로젝트의 전체 범위입니다.

## 특징

- 📱 **개인 어시스턴트** — 단일 사용자가 WeChat에서 단일 pi 세션을 원격 조작하도록 설계
- 🔐 **QR 코드 로그인** — WeChat으로 스캔하여 인증
- 🔄 **양방향 동기화** — WeChat ↔ TUI 메시지가 양쪽에서 표시
- 🖼️ **이미지 지원** — 다운로드, 복호화, 모델에 전송하여 분석
- 📁 **파일 지원** — WeChat에서 파일을 수신하여 프로젝트 디렉토리에 저장, 프로젝트 파일을 WeChat으로 전송
- 🗣️ **음성 지원** — WeChat 내장 음성 인식 활용
- 💬 **메시지 큐잉 & 배치** — 연속 메시지 자동 병합, 여러 이미지는 텍스트 보충을 대기 후 일괄 처리
- 🔒 **배타적 잠금** — 동시에 하나의 TUI 세션만 WeChat 연결 유지
- 📊 **상태 표시줄** — TUI 하단에 WeChat 연결 상태와 대기 메시지 수 표시

## 빠른 시작

### 설치

```bash
pi install npm:pi-wechat-assistant
```

또는 GitHub에서:

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### 사용법

pi TUI에서 실행:

```
/wechat login
/wechat start
```

WeChat에서 봇을 찾아 메시지를 보내기만 하면 됩니다.

## TUI 명령어

| 명령어 | 설명 |
| --- | --- |
| `/wechat login` | QR 코드 스캔하여 로그인 |
| `/wechat login --force` | 강제 재스캔 |
| `/wechat start` | WeChat 연결 시작 |
| `/wechat stop` | 중지 및 잠금 해제 |
| `/wechat status` | 연결 상태 및 설정 표시 |
| `/wechat config` | 이미지 관련 설정 표시 |
| `/wechat config source on\|off` | WeChat 출처 및 응답 규칙 전환 (기본 비활성화) |
| `/wechat prompt show\|init\|reload` | 응답 템플릿 보기, 생성, 다시 로드 |
| `/wechat config image-wait <ms>` | 배치 대기 시간 설정 (기본값 `8000`) |
| `/wechat config image-max <MB>` | 이미지 크기 제한 설정 (기본값 `50`) |
| `/wechat autostart` | 세션 시작 시 자동 시작 전환 |
| `/wechat remotetools` | WeChat 측 `/tools` 명령 전환 (기본 **비활성화**) |
| `/wechat logout` | 자격 증명 지우기 및 중지 |

## WeChat 원격 명령어

WeChat에서 텍스트, 음성, 이미지를 보내면 일반 대화입니다. 추가 명령어:

| 명령어 | 설명 |
| --- | --- |
| `/status` | 모델, 컨텍스트 사용량, 큐, 설정 |
| `/stop` | 현재 생성 중단 |
| `/model` | 사용 가능한 모델 목록 |
| `/model <이름>` | 모델 전환 |
| `/config` | 이미지 설정 표시 |
| `/name <이름>` | 세션 이름 설정 |
| `/session` | 세션 상세 정보 |
| `/help` | 도움말 표시 |

고급: `/thinking`, `/compact`. WeChat 측 `/tools`는 기본적으로 **비활성화**되어 있습니다 (로컬 도구 권한을 변경할 수 있음). TUI에서 `/wechat remotetools on`으로 활성화하세요.

## 지원 메시지 유형

| 유형 | 상태 |
| --- | --- |
| 텍스트 | ✅ |
| 음성 | ✅ (WeChat 음성 인식) |
| 이미지 | ✅ (다운로드 후 모델에 전송) |
| 인용 답장 | ✅ (인용 텍스트 추가) |
| 파일 | ✅ (프로젝트 디렉토리에 저장) |
| 동영상 | ❌ 미지원 |

## 설정

### 환경 변수

| 변수 | 설명 | 기본값 |
| --- | --- | --- |
| `PI_WECHAT_DEBUG` | `1`로 설정 시 디버그 로그 활성화 | 꺼짐 |
| `PI_WECHAT_DEBUG_FILE` | 디버그 로그 경로 | `~/.pi/agent/wechat-assistant/debug.log` |
| `PI_WECHAT_IMAGE_BATCH_WAIT_MS` | 이미지 배치 대기 시간 | `8000` |
| `PI_WECHAT_IMAGE_MAX_BYTES` | 이미지 크기 제한 | `52428800` (50 MB) |

### 설정 파일

```
~/.pi/agent/wechat-assistant/
├── credentials.json    # 로그인 자격 증명 (권한 600)
├── config.json         # 자동 시작, 원격 도구, 이미지 제한 (권한 600)
├── context-tokens.json # 연결된 사용자의 응답 컨텍스트 (권한 600)
├── cursor.json         # 롱 폴링 커서 (권한 600)
├── seen-ids.json       # 중복 제거용 최근 메시지 ID (권한 600)
└── session.lock        # 배타적 잠금 파일 (권한 600)
```

상태 디렉터리 자체의 권한은 `700`입니다.

## 아키텍처

```
WeChat  ⇄  pi TUI 세션  ⇄  AI 모델 + 도구
```

- WeChat 메시지는 iLink Bot API 롱 폴링으로 가져옴
- QR 로그인으로 연결된 WeChat 사용자만 허용하며 다른 사용자의 메시지는 무시
- 수신 메시지는 `pi.sendUserMessage()` 로 현재 pi 세션에 주입
- TUI에서 입력하면 WeChat 측에 미리보기 전송
- AI 응답은 증분 전송 (`message_end` 마다), `agent_end` 보완 없음 (세션 복원 후 과거 응답 중복 방지)
- `/wechat start` 를 실행한 TUI 세션만 연결 유지

## FAQ

**WeChat에서 응답이 없음?** `/wechat status` 로 상태 확인. 세션 만료 시 `/wechat login --force` 실행.

**"다른 pi 인스턴스가 사용 중" 표시?** 다른 TUI 세션이 잠금을 유지 중. 해당 세션에서 `/wechat stop` 실행.

**이미지가 바로 처리되지 않는 이유?** 배치 처리를 위해 최대 8초 대기. 여러 이미지 연속 전송 후 텍스트로 보충 가능. 첫 이미지는 즉시 확인 응답, 대기 중 텍스트 전송 시 즉시 처리.

## 개발

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
npm install
npm run typecheck

# 빠른 테스트
pi -e ./src/index.ts
```

## 릴리스

```bash
npm version patch   # package.json 업데이트, 커밋, 태그 생성
git push --follow-tags   # CI → npm 게시 + GitHub Release 트리거
```

## 라이선스

[MIT](LICENSE)
