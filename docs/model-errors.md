# Model error notifications

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/model-errors.zh.md)

While `/wechat start` is active, failed model requests are reported to the current reply recipient. No extra switch is needed. With `/wechat config bidirectional off`, only bridge-originated requests generate these notices; with sync on, TUI requests are included. The source-marker switch does not affect error routing.

- Read `stopReason: "error"` and `errorMessage` from new assistant `message_end` events. Ordinary words such as “error” or “failed”, tool failures, empty responses, and historical messages are not failure signals.
- On Pi 0.99.2, 1.1.0 and 1.2.0, wait for `agent_settled` and require an error outcome at `agent_before_settle`. Automatic retry success produces no failure notice. `agent_end` alone is not a terminal event.
- Pi 0.84.x exposes `agent_settled` without `agent_before_settle` or an aborted flag. At settlement, an outstanding model error produces only “A previous model request failed: …”, without claiming a terminal failure or recommending a retry. Cancellation during retry backoff may also produce this conservative notice because these public events cannot distinguish it from retry exhaustion. Successful retries clear the error and produce no notice.
- On Pi 0.73.1 and 0.78.0, the extension API does not expose final settlement or automatic retry events. Send at most one factual notice per consumed user request: the current model request failed and Pi may retry. Do not claim the entire task has stopped. A later successful response is still forwarded.
- Abort messages and aborted signals do not generate failure notices. Pi 1.1.0+ additionally supplies `agent_settled.aborted`. Pi 0.99.2 cancellation during retry backoff skips the pre-settlement boundary and is suppressed; cancellation initiated by another extension inside that boundary cannot always be distinguished on this older API.
- For an idle bridge input, missing model/auth configuration can fail before any lifecycle event. Check public model/registry APIs and report that startup failure, removing the rejected submission from the bridge queue. Modern lazy auth is resolved before concluding it is unavailable. Busy queued inputs are not preemptively rejected.
- Keep source routing through retry loops. Claim a notice before sending and do not retry after an ambiguous transport failure. Failed partial assistant text is not forwarded, since retries may repeat it. Diagnostics are shortened and common credential patterns and URL query/fragment data are removed.

Scope: this covers structured model failures and the model/auth startup checks above, not arbitrary exceptions in other extensions or every Pi UI error. It cannot guarantee delivery when WeChat itself is unavailable. User-request identity follows consumed user messages; a newly consumed follow-up begins a new notification scope.

## Compatibility evidence

The published API matrix includes 0.73.1, 0.78.0, 0.84.0, 0.84.4, 0.99.2, 1.1.0 and 1.2.0. The runtime probe uses public API signatures: `ctx.isProjectTrusted` distinguishes settled-event hosts, and the unsubscribe function returned by `pi.on` distinguishes boundary-capable hosts from 0.84.x (which returns void). `npm run typecheck:pi` asserts both relationships and the expected event availability per version. Capability selection is independent of request history, including the first cancellation after startup. Unknown signatures fall back to conservative attempt/settlement notices; arbitrary forks that mimic these signatures may still differ in event semantics. Old loaders accept unknown event registrations without dispatching them. No private session APIs or log scraping are used.

- [Pi 0.73.1 extension API](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/docs/extensions.md), [session implementation](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/src/core/agent-session.ts)
- [Pi 0.78.0 extension API](https://github.com/earendil-works/pi/blob/v0.78.0/packages/coding-agent/docs/extensions.md)
- [Pi 0.84.0 session implementation](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/agent-session.ts), [Pi 0.84.4 extension API](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/extensions.md)
- [Pi 0.99.2 extension API](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/extensions.md), [settlement implementation](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/src/core/agent-session.ts)
- [Pi 1.1.0 event types](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/types.ts)
- [Pi 1.2.0 extension API](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md), [session implementation](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts)
