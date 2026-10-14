# Settings / 配置

## English

Run `/wechat config` to open host-native selection and input dialogs. Each row includes its current value and a short explanation. Image settings offer presets (0/2/8/15 seconds and 10/20/50 MB) plus custom input with units and ranges. Select a setting, then choose a value; each confirmed change is saved separately. Esc cancels a value choice, returns from advanced settings, or closes the main menu. Opening settings does not start the bridge or register sending tools. Without UI, the command shows text; `/wechat config show` always shows text.

| Location | Setting | Default | Purpose |
| --- | --- | --- | --- |
| Common | Bidirectional sync | On | Forward new desktop input and AI replies to WeChat. Off keeps only replies to WeChat requests. |
| Common | Auto-start WeChat bridge | Off | Attempt to connect WeChat when a pi session opens. In the TUI, a bridge held by another session follows the handoff mode below (ask or auto); headless modes report the lock instead of asking. Enabling it offers to switch the handoff mode to Auto. Does not start/stop the current bridge. |
| Common | Bridge handoff mode | Ask | When another session holds a cooperative-handoff bridge (0.4.4+), Ask shows the takeover dialog and Auto requests the handoff directly. Headless modes never auto-take-over. |
| Common | WeChat message tag and formatting | On | One switch for the `[微信]` marker, WeChat-friendly reply formatting, and the local question-tool guard. Waits for an active task to finish before changing. |
| Common | Reply template actions | Packaged template | View template/path, export without overwriting, or reload an edited file. These are actions, not additional switches. |
| Advanced | WeChat /tools override | Off | Allow WeChat `/tools` to modify local tool permissions. This does not control the two WeChat file/image sending tools. |
| Advanced | Burst-image batch delay | 8000 ms | Wait for related image messages; text arrives sooner and triggers processing. Range 0–60000 ms; zero disables waiting. |
| Advanced | Image download limit | 50 MB | Maximum downloaded image size; minimum 1 MB. Does not change the separate outgoing-file size limit. |

Keep custom source-marker text and the blocked local question-tool names in `config.json`: these serve unusual integrations, rather than routine settings. Keep reply prose in `wechat-prompt.md`. Login credentials, message-send credentials, lock ownership, and the current running state are not editable preferences.

Configuration is stored at `~/.pi/agent/wechat-assistant/config.json`. Saves affect this process and future sessions. Already-open processes cache their settings and do not reload another process's changes automatically; reload the extension or reopen the session before editing settings from another process. Image environment variables remain fallbacks when no corresponding JSON setting exists; the menu shows effective image values. There is no new cross-process settings synchronization in this change.

Existing commands remain supported. Additional explicit commands are `/wechat config auto-start on|off`, `/wechat config handoff ask|auto`, and `/wechat config remote-tools on|off`. For reply files and system-prompt behavior see [WeChat rules](wechat-source.md).

## 中文

执行 `/wechat config` 打开 pi 自带的选择和输入窗口。列表直接显示当前值和简短用途。图片设置先提供常用预设（不等待 / 2 / 8 / 15 秒，以及 10 / 20 / 50 MB），也可选择“自定义”，按单位和范围提示填写。先选配置项，再选值；每次确认单独保存。Esc 取消当前值选择、从高级设置返回，或关闭主菜单。打开设置不会启动桥接，也不会注册发送工具。无 UI 时显示文本；`/wechat config show` 始终显示文本。

| 位置 | 配置项 | 默认值 | 为什么需要 |
| --- | --- | --- | --- |
| 常用 | 双向同步 | 开启 | 控制是否同步新的电脑输入和 AI 回复；关闭后仅回传微信任务回复。 |
| 常用 | 自动启动微信桥接 | 关闭 | 打开 pi 会话时尝试连接微信。TUI 下若桥接被其他会话持有，按下方「持锁接管方式」处理；无界面模式只报告锁占用。开启时会引导把接管方式改为自动。不改变当前桥接启停状态。 |
| 常用 | 持锁接管方式 | 询问 | 其他会话持有协作交接（0.4.4+）的桥接时，询问 = 弹窗确认，自动 = 直接请求旧会话交接。无界面模式始终不自动接管。 |
| 常用 | 微信消息标识与排版 | 开启 | 微信消息加来源标记（默认 [微信]），引导 AI 用短段落和文字提问，并拦截已配置的本机提问工具；有任务运行时等待其结束再修改。 |
| 常用 | 回复模板操作 | 内置模板 | 查看模板及路径、导出默认模板、不覆盖已有文件、重载编辑后的模板；这些是操作，不额外增加开关。 |
| 高级 | 微信端 /tools 修改本机权限 | 关闭 | 允许微信 `/tools` 命令修改本机工具权限；不控制微信文件和图片发送工具的启停。 |
| 高级 | 连发图片合并等待 | 8000 毫秒 | 微信连发多张图时凑成一批处理，文字到来可提前处理；范围 0–60000，0 表示不等待。 |
| 高级 | 单张图片下载上限 | 50 MB | 限制下载图片的大小，最低 1 MB；不改变发出文件的独立大小限制。 |

自定义来源标识、阻塞提问工具名单属于少数特殊接入需求，继续通过 `config.json` 修改，不放进日常设置窗口。回复措辞放在 `wechat-prompt.md`。登录凭据、消息发送凭据、锁归属和当前运行状态不作为可编辑配置项。

配置保存在 `~/.pi/agent/wechat-assistant/config.json`。保存后本进程和以后新开的会话使用新值；其他已打开进程有自己的缓存，不会自动重读。若要换进程修改配置，先重载扩展或重新打开会话。图片环境变量仍作为没有对应 JSON 配置时的回退值，窗口显示实际生效的图片设置。本次没有新增跨进程配置实时同步。

原有命令保留，新增显式命令 `/wechat config auto-start on|off`、`/wechat config handoff ask|auto`、`/wechat config remote-tools on|off`。回复模板的位置和系统提示词行为见[微信回复规则](wechat-source.md)。
