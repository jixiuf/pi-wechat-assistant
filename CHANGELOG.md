# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Optional `[微信]` source marker and user-editable reply template, sharing one switch (on by default), with guards for known local question tools (#16).
  可选微信来源标识与可编辑回复模板共用一个开关（默认开启），并守卫已知本机提问工具（#16）。
- `/wechat config source on|off` and `/wechat prompt show|init|reload`; published Pi API checks for 0.73.1 through 1.2.0.
  新增来源开关、模板查看/导出/重载命令，以及 pi 0.73.1 至 1.2.0 的已发布 API 检查。

### Changed
- Unframed compact footer with a green WeChat logo (white fallback), a two-way sync arrow, and green/red running/stopped icons; keep routine diagnostics in `/wechat status` and refresh sync indicators immediately.
  底部去掉方括号，精简为微信绿图标（白色降级）、双向同步箭头和绿/红启停图标；常规诊断留在 `/wechat status`，切换同步立即刷新。
- Reply rules live in one conditional system-prompt section appended only to runs triggered by a bridge submission; TUI runs keep a clean prompt with zero WeChat awareness, and WeChat user messages carry only the source marker.
  回复规则放在条件化系统提示词段中，仅追加到桥接投递触发的任务；电脑端任务系统提示词完全不含微信内容，微信用户消息仅携带来源标识。
- `/wechat status` now reports the latest online/offline state-notification results, and failed lifecycle notifications surface a warning without blocking start/stop.
  `/wechat status` 新增上/下线状态通知结果，启停状态通知失败时给出警告且不阻断启停。
- WeChat formatting retains link URLs, converts tables to labelled rows, and sends lossless code chunks with Unicode-safe boundaries.
  微信排版保留完整 URL、将表格转为逐行说明，并支持保留原文的代码分块与 Unicode 安全切分。

### Fixed
- Notifications no longer print to stdout while the TUI is attached (debug output painted notify text over the editor); debug logging stays in the debug file.
  修复 TUI 模式下通知同时打印到 stdout、把文字绘制进输入框区域的问题；调试日志仅写入调试文件。
- Send WeChat text verbatim instead of trimming it, preserving code-chunk indentation and trailing newlines.
  发送微信文本不再整体 trim，保留代码块的缩进和末尾换行。
- Track consumed WeChat follow-ups within an active run and preserve file notes while downloads or earlier submissions are pending.
  修复同一次运行中微信追加消息的来源路由，以及下载或先前投递未完成时文件说明丢失的问题。

## [0.3.1] - 2026-09-04

### Security
- 仅接受扫码凭证绑定用户的微信消息，其他用户不会缓存上下文、进入队列或触发 Agent（感谢 JOM）
- 微信端 `/tools` 默认禁用，只能从本机 TUI 显式开启
- 状态目录和状态文件权限分别收紧为 `700` 和 `600`

### Fixed
- 持久化长轮询游标和近期消息 ID，防止重启后重复处理历史消息（感谢 midmirror）
- 移除 `agent_end` 历史回复补发，防止恢复会话后重复发送全部旧回复（感谢 midmirror）
- 强制重新登录或退出时清理旧凭证对应的游标、去重和上下文状态

### Changed
- CI 和发布工作流升级 GitHub Actions 运行时，并改用 `npm ci`

## [0.3.0] - 2026-06-11

### Added
- 单元测试（vitest，47 用例）：`utils`、`message`、`queue` 模块
- 进程退出清理：`SIGINT`/`SIGTERM`/`beforeExit` 自动释放锁 + 落盘 context tokens
- 图片预下载并发控制（`Semaphore`，上限 3 并发）
- CI 增加测试检查（`npm test`）

### Changed
- **Breaking**: `MessageQueue` drain 防重入保护（`_draining` 标志位）
- **Breaking**: `CommandDeps.loadClient` / `lock` / `unlock` 接口改为 async
- **Breaking**: `WeixinClient` 构造函数不再执行 I/O，改用 `WeixinClient.create()` 静态工厂
- 全部文件 I/O 从同步改为 `fs.promises` 异步
- sendFile/sendImage 重复代码提取为 `sendMedia()` 通用方法
- AI 工具守卫逻辑提取为 `guardSendToWechat()` / `guardFileSize()`
- Context token 持久化从立即写入改为 5 秒节流写入（退出时立即落盘）
- 散落的 turn 状态变量封装为 `TurnContext` 类
- 语音无转写消息改为友好提示文案

### Fixed
- `queue.drain()` 中 `setTimeout(0)` 堆叠问题（改用 `setImmediate` + 防重入）
- `tsconfig.json` `rootDir` 修正，`include` 包含根 `index.ts`

## [0.2.1] - 2026-06-10

### Changed
- 重构项目结构：所有源码移至 `src/` 目录
- 模块化拆分：`index.ts`（1378 行）拆分为 8 个职责清晰的模块
- 优化 CI：新增 typecheck 持续集成，发布流程支持 OIDC Trusted Publishing
- 新增 `preversion` hook：发版前自动 typecheck

## [0.2.0] - 2026-06-03

### Added
- 文件消息支持（下载、解密、保存到项目目录）
- 远程命令 `/name`、`/session`
- `send_file_to_wechat` / `send_image_to_wechat` AI 工具
- TUI 输入 → 微信双向同步（预览 + 图片注释）
- 增量回复发送（`message_end` 即发，不等 `agent_end`）
- 图片/文件批处理：连续发送多张图片或多文件时合并处理
- 调试日志（`PI_WECHAT_DEBUG=1`）

### Changed
- 微信时间戳从 system prompt 移至 user message 前缀

## [0.1.3] - 2026-05-30

### Added
- 远程命令：`/model`、`/thinking`、`/tools`、`/compact`、`/stop`、`/status`、`/help`
- 图片支持（下载、AES 解密、发送给模型分析）
- 消息队列 + 合并排队
- 排他锁（同一时间只有一个 TUI session 连接微信）
- 状态栏显示微信连接状态
- 扫码登录（QR code + 轮询）

## [0.1.0] - 2026-05-30

### Added
- 初始版本：微信 iLink Bot 桥接
- 文字消息双向同步
- 语音消息支持（使用微信语音转文字）
