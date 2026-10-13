# WeChat source and reply rules / 微信来源与回复约定

## English

The source marker, reply template, and question-tool guard share one switch, **on by default**:

```text
/wechat config source on
/wechat config source off
```

When enabled, each submitted WeChat batch starts with `[微信]`, followed by the original input only. Text, voice transcripts, quoted replies, image descriptions, and saved-file notes use the same path. A merged batch carries one marker. Files received without accompanying text or images are saved and acknowledged without starting an AI task.

The bridge identifies its own submitted messages when Pi consumes them. A marker typed in TUI, or `input.source === "extension"` alone, does not establish WeChat origin. This routing also works with the switch off and for follow-ups received during an existing run. With `/wechat config bidirectional off`, TUI replies stay local and WeChat task replies still return to WeChat.

### Edit the reply template

The packaged default is [`prompts/wechat.md`](../prompts/wechat.md). The optional user override is `~/.pi/agent/wechat-assistant/wechat-prompt.md` (normally `C:\Users\<user>\.pi\agent\wechat-assistant\wechat-prompt.md` on Windows).

```text
/wechat prompt show
/wechat prompt init
/wechat prompt reload
```

`show` displays the loaded template and its path. `init` exports the default and refuses to overwrite an existing file. Edit that file, then run `reload`; the next agent run uses the updated rules (the command waits for the current task to finish). Already submitted messages, queued Pi follow-ups, and history retain their original text. A failed reload preserves the last valid template. Removing the override and reloading restores the packaged default.

The rules ask for short paragraphs, numbered choices, and questions answered through WeChat. They apply only to the current WeChat request and its replies; later inputs from TUI or another source follow normal Pi behavior.

### System prompts and cache behavior

While the bridge runs with the source feature on (the default), every agent run appends one fixed `<wechat-system-rules>` section to the system prompt, regardless of whether the input came from WeChat or the TUI. The section states that the WeChat rules are conditional: they apply only when the latest user request was delivered by the bridge and starts with the source marker. User messages carry only the marker and the original input; history is never rewritten.

Because the section is identical for WeChat and TUI turns, alternating input sources does not rewrite the system prompt. Toggling the source feature or reloading the template changes only future runs — both commands wait for the current task to finish — so a running reply keeps its original rules. Starting and stopping the bridge still changes the tool set (see below) and can affect prompt caching; the source switch itself does not.

### Local question tools

When this feature is enabled for a confirmed WeChat request, `tool_call` blocks the official `question` and `questionnaire` example tools and asks the model to put its question in the reply text. Normal TUI requests remain unaffected. Pi versions supporting nested tool execution also apply this guard to those calls, including calls through codemode.

For other question tools, list their exact registered names in `config.json`:

```json
{
  "messageSourceTag": {
    "enabled": true,
    "wechatTag": "[微信]",
    "blockedTools": ["question", "questionnaire", "ask_user"]
  }
}
```

`wechatTag` is optional; `[微信]` is the default. Omitting `blockedTools` uses the two official example names; `[]` disables the guard. Other tools that open local UI need their names added explicitly. The template can guide the model but cannot automatically identify every third-party blocking UI tool. Restart Pi after directly editing `config.json`; the TUI source switch updates the system rules for the next run and waits for the current task to finish.

### WeChat text formatting

Only the outgoing WeChat copy is formatted; the Pi transcript retains the original Markdown. Links retain their labels and complete URLs. Headings and emphasis become plain text; tables become labelled rows. Fenced code is sent separately with its language and chunk order, preserving indentation, blank lines, and special characters. Code chunks prefer line boundaries and can be reassembled by removing each chunk's first label line and concatenating the bodies. Long single lines are split at Unicode grapheme boundaries.

Text targets 800 UTF-16 code units per message. An indivisible URL or grapheme may exceed that target to preserve it. Large code/report files can also be sent with `send_file_to_wechat`.

### Compatibility validation

`npm run typecheck:pi` checks the published APIs for Pi **0.73.1, 0.78.0, 0.99.2, 1.1.0, and 1.2.0**. It downloads integrity-checked declarations into the project's `node_modules/.cache`, without replacing installed dependencies. `npm test` exercises legacy/new startup event forms, tool activation, source routing, follow-ups, template reloads, mixed media, and formatting. These automated checks do not connect to a real WeChat account or model provider.

The implementation uses stable `sendUserMessage`, `input`, message lifecycle, `tool_call`, and active-tool APIs. Every submission explicitly specifies `deliverAs: "followUp"`. It holds submissions during the observed `before_agent_start` phase, then drains at `agent_start` and message consumption. It does not depend on startup event `prompt`, the newer `messageType` union, or system prompt sections.

References: [Pi 1.2.0 extension contracts](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md), [Pi 1.2.0 startup concurrency changes](https://github.com/earendil-works/pi/releases/tag/v1.2.0), [Pi 0.73.1 dynamic tools](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/examples/extensions/dynamic-tools.ts).

## 中文

来源标识、微信回复模板和提问工具守卫共用一个开关，**默认开启**：

```text
/wechat config source on
/wechat config source off
```

开启后，每个新投递的微信消息批次以 `[微信]` 开头，随后仅附带用户原文。文字、语音转写、引用回复、图片描述及已保存文件的信息统一处理，合并后的批次只加一次。单独收到文件时仍只保存并回执，不触发 AI。

桥接根据自己的投递记录，在 pi 真正消费消息时判断来源。TUI 手工输入来源标识，或仅有 `input.source === "extension"`，都不会自动被认作微信消息。开关关闭及任务运行中追加消息时，来源路由仍然有效。使用 `/wechat config bidirectional off` 时，电脑端回复不转发，微信任务回复继续正常返回。

### 修改回复模板

内置模板位于 [`prompts/wechat.md`](../prompts/wechat.md)。用户覆盖文件为 `~/.pi/agent/wechat-assistant/wechat-prompt.md`，Windows 通常是 `C:\Users\<用户名>\.pi\agent\wechat-assistant\wechat-prompt.md`。

```text
/wechat prompt show
/wechat prompt init
/wechat prompt reload
```

`show` 查看当前加载的模板及路径；`init` 导出默认模板，不覆盖已有文件。编辑后执行 `reload`，下一次任务启动时使用新规则（命令会等待当前任务结束）。已经投递的消息、pi 内部排队的追加消息及历史消息保持原样。加载失败时保留之前的有效模板；删除覆盖文件并重新加载即可恢复内置模板。

模板要求短段落、简单编号，并通过微信正文提问。规则只适用于当前微信请求及其回复，之后的电脑端或其他来源输入按正常 pi 方式处理。

### 系统提示词和缓存

桥接运行且来源功能开启（默认）时，每次任务都会在系统提示词末尾追加同一段固定的 `<wechat-system-rules>`，不区分本次输入来自微信还是电脑端。该段明确规则是条件性的：仅当最新用户请求由桥接投递并以来源标识开头时才套用。用户消息只携带来源标识和原文，历史不会被改写。

由于微信/电脑端交替输入时该段完全一致，切换输入源不会重写系统提示词。切换来源开关或重载模板只影响之后的任务（两条命令都会等待当前任务结束），进行中的回复保持原规则。启动和停止桥接仍会改变工具集（见下）并可能影响提示词缓存；来源开关本身不会。

仅安装但不启动桥接，不注册微信发送工具。启动时注册并激活文件/图片工具，停止时移出活动工具集。因此，启动和停止会改变工具集，可能影响提示词缓存；切换来源开关或输入渠道不改变工具集。

### 本机提问工具

功能开启且当前请求经桥接确认来自微信时，`tool_call` 会阻止官方示例中的 `question` 和 `questionnaire` 工具，要求模型改在回复正文里提问。电脑端请求不受影响。支持嵌套工具执行的 pi 版本也会对这类调用应用守卫，包括通过 codemode 发起的调用。

使用其他提问工具时，在 `config.json` 中加入准确的注册名称：

```json
{
  "messageSourceTag": {
    "enabled": true,
    "wechatTag": "[微信]",
    "blockedTools": ["question", "questionnaire", "ask_user"]
  }
}
```

`wechatTag` 可省略，默认 `[微信]`；`blockedTools` 可省略，默认包含两个官方示例名称，设为 `[]` 可以关闭守卫。其他会打开本机界面的工具需要明确添加名称，模板无法自动识别所有第三方阻塞工具。直接修改 `config.json` 后重启 pi；TUI 来源开关在下一次任务启动时更新系统规则，并等待当前任务结束。

### 微信排版

只转换发往微信的副本，pi 会话保留原始 Markdown。链接保留名称与完整 URL；标题和强调转成普通文字；表格转成逐行说明。代码单独发送，标注语言和块序号，保留缩进、空行和特殊字符，优先按行切分。去掉每块首行标签后，直接拼接代码正文即可还原；超长单行按 Unicode 字素边界切分。

普通消息以 800 个 UTF-16 代码单元为分段目标，完整 URL 或单个字素超过目标时保留整体。特别长的代码或报告也可以用 `send_file_to_wechat` 发送文件。

### 兼容验证

`npm run typecheck:pi` 针对 pi **0.73.1、0.78.0、0.99.2、1.1.0、1.2.0** 的已发布 API 检查类型。脚本校验下载包完整性，缓存放在项目的 `node_modules/.cache`，不替换本地依赖。`npm test` 覆盖新旧启动事件形式、工具启停、来源路由、忙碌时追加消息、模板重载、混合媒体和格式转换。自动检查不连接真实微信账号或模型服务。

实现使用稳定的 `sendUserMessage`、`input`、消息生命周期、`tool_call` 和活动工具接口；每次投递显式指定 `deliverAs: "followUp"`。观察到 `before_agent_start` 准备阶段时暂缓投递，在 `agent_start` 和消息消费时继续处理队列；不依赖启动事件的 `prompt`、新版 `messageType` 联合类型或系统提示词分区。

参考：[pi 1.2.0 扩展约定](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md)、[pi 1.2.0 启动并发变化](https://github.com/earendil-works/pi/releases/tag/v1.2.0)、[pi 0.73.1 动态工具示例](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/examples/extensions/dynamic-tools.ts)。
