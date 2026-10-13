# Model error notifications / 模型错误通知

## English

While `/wechat start` is active, failed model requests are reported to the current reply recipient. No extra switch is needed. With `/wechat config bidirectional off`, only bridge-originated requests generate these notices; with sync on, TUI requests are included. The source-marker switch does not affect error routing.

- Read `stopReason: "error"` and `errorMessage` from new assistant `message_end` events. Ordinary words such as “error” or “failed”, tool failures, empty responses, and historical messages are not failure signals.
- On Pi 0.99.2, 1.1.0 and 1.2.0, wait for `agent_settled` and require an error outcome at `agent_before_settle`. Automatic retry success produces no failure notice. `agent_end` alone is not a terminal event.
- Intermediate hosts such as Pi 0.84.x expose `agent_settled` but never emit `agent_before_settle`. The boundary requirement is latched per host: until a boundary event has been observed, a settlement with an observed error notifies directly; once the host is known to emit boundary events, a non-error boundary suppresses the notice because an automatic retry recovered.
- On Pi 0.73.1 and 0.78.0, the extension API does not expose final settlement or automatic retry events. Send at most one factual notice per consumed user request: the current model request failed and Pi may retry. Do not claim the entire task has stopped. A later successful response is still forwarded.
- Abort messages and aborted signals do not generate failure notices. Pi 1.1.0+ additionally supplies `agent_settled.aborted`. Pi 0.99.2 cancellation during retry backoff skips the pre-settlement boundary and is suppressed; cancellation initiated by another extension inside that boundary cannot always be distinguished on this older API.
- For an idle bridge input, missing model/auth configuration can fail before any lifecycle event. Check public model/registry APIs and report that startup failure, removing the rejected submission from the bridge queue. Modern lazy auth is resolved before concluding it is unavailable. Busy queued inputs are not preemptively rejected.
- Keep source routing through retry loops. Claim a notice before sending and do not retry after an ambiguous transport failure. Failed partial assistant text is not forwarded, since retries may repeat it. Diagnostics are shortened and common credential patterns and URL query/fragment data are removed.

Scope: this covers structured model failures and the model/auth startup checks above, not arbitrary exceptions in other extensions or every Pi UI error. It cannot guarantee delivery when WeChat itself is unavailable. User-request identity follows consumed user messages; a newly consumed follow-up begins a new notification scope.

### Compatibility evidence

Checked the published declarations and session/agent-loop implementations for all five versions. The runtime capability probe uses the public `ctx.isProjectTrusted` method, present in the three settled-event hosts and absent in the two legacy hosts in this matrix. `npm run typecheck:pi` asserts that relationship; this is not a universal feature-discovery contract for arbitrary forks. Old loaders accept unknown event registrations without dispatching them. No private session APIs or log scraping are used.

- [Pi 0.73.1 extension API](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/docs/extensions.md), [session implementation](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/src/core/agent-session.ts)
- [Pi 0.78.0 extension API](https://github.com/earendil-works/pi/blob/v0.78.0/packages/coding-agent/docs/extensions.md)
- [Pi 0.99.2 extension API](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/extensions.md), [settlement implementation](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/src/core/agent-session.ts)
- [Pi 1.1.0 event types](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/types.ts)
- [Pi 1.2.0 extension API](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md), [session implementation](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts)

## 中文

`/wechat start` 启动后，模型请求失败会通知当前回复接收方，无需新增配置。关闭双向同步时，只通知桥接收到的微信请求；开启时也同步电脑端请求的错误。关闭来源标识不会关闭错误通知。

- 只依据新助手消息的结构化 `stopReason: "error"` 和 `errorMessage`，不扫描正文关键词，不把工具失败、空回复或历史消息误当成新故障。
- Pi 0.99.2、1.1.0、1.2.0：等待自动重试、压缩及继续执行结束，由 `agent_before_settle` 的错误状态与 `agent_settled` 确认后通知。重试成功不报错，不能仅凭 `agent_end` 判断任务停止。
- 0.84.x 等中间版本有 `agent_settled` 但不会发出 `agent_before_settle`。边界要求按宿主锁存：尚未见过边界事件时，稳定结束且存在观察到的错误即直接通知；宿主已知会发边界事件后，非错误边界代表重试成功，不再通知。
- Pi 0.73.1、0.78.0：扩展无法观察最终稳定状态或自动重试事件。每条实际消费的用户请求最多发送一次“本次模型请求失败，Pi 可能自动重试”，不宣称整个任务已停止；后续成功回复仍正常发送。
- 取消消息和已取消的信号不报错；1.1.0 起还检查最终事件的 `aborted`。0.99.2 在重试等待中取消会跳过结束前边界，因此不通知；其他扩展恰好在结束前边界中取消的情况，该旧版 API 无法始终准确区分。
- 空闲时的微信输入，提前检查公共 API 中的模型和认证状态，覆盖尚未进入消息循环就被拒绝的情况，并清理被拒绝的投递记录。新版允许动态解析认证，避免把暂时未配置的同步快照误判成失败；忙碌时的追加输入不提前拦截。
- 自动重试保留微信来源；通知在发送前去重，发送结果不明时不自动补发；错误或取消消息中的不完整正文不转发，避免重试时重复。错误摘要限制长度，过滤常见凭证形式及 URL 查询参数、片段。

范围仅限上述模型错误和启动检查，不涵盖其他扩展任意异常或所有 Pi 界面报错；微信服务不可用时也无法保证送达。新追加消息真正进入模型时，会建立新的通知范围。

以上五个版本均检查了官方文档、已发布类型和消息循环源码，参考链接见上方。能力判断采用这组版本中与结束事件共同存在的 `ctx.isProjectTrusted`，类型兼容脚本验证两者对应关系；不保证任意第三方分支具有相同关系。实现不访问私有会话 API，也不抓取终端日志。
