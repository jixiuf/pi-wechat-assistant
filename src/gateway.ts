// ============================================================================
// WechatGateway — 微信渠道 IGateway 实现（纯协议适配层）
// 职责：iLink 轮询 → InboundMessage；send() → iLink 协议发送
// 不含任何协调逻辑：接管/锁/消息路由/命令分发全部由 pi-hub 负责
// ============================================================================

import { WeixinClient } from './client.js'

// IGateway 契约的本地结构声明（duck typing）：渠道不 import hub 任何代码，
// 类型形状与 pi-hub/src/types.ts 保持一致即可被 hub 接受。
interface GatewayAttachment {
  kind: 'image' | 'file' | 'voice'
  ref: unknown
}

export interface InboundMessage {
  id: string
  channel: string
  userId: string
  text?: string
  attachments?: GatewayAttachment[]
  ts: number
  /** 渠道原始消息（供 handleUserMessage 恢复完整上下文，hub 不读取） */
  rawMessage?: unknown
}

export interface OutboundMessage {
  text?: string
  attachments?: { kind: 'image' | 'file'; path: string; name?: string }[]
}

export interface IGateway {
  readonly kind: string
  readonly capabilities: { text: boolean; image: boolean; file: boolean; voice: boolean }
  connect(): Promise<void>
  disconnect(): Promise<void>
  onInbound(h: (m: InboundMessage) => void): void
  send(target: string, m: OutboundMessage): Promise<void>
  fetchAttachment(ref: unknown): Promise<Buffer | null>
  handleUserMessage?(m: InboundMessage): void | Promise<void>
  isAwaitingAnswer?(userId: string): boolean
}

export class WechatGateway implements IGateway {
  readonly kind = 'wechat'
  readonly capabilities = { text: true, image: true, file: true, voice: true } as const

  private client: WeixinClient | null = null
  private inbound: ((m: InboundMessage) => void) | null = null
  private pollAbort: AbortController | null = null
  private _running = false

  constructor(private readonly deps: {
    getClient: () => WeixinClient | null
    /** 渠道自有消息处理（会话命令/问卷/入队），由 index.ts 装配 */
    handleUserMessage: (m: InboundMessage) => void
    /** 是否正在等待该用户的问卷答案（宽松 use 匹配时用于避免误吞数字答案） */
    isAwaitingAnswer?: (userId: string) => boolean
    /** 心跳/状态回调（更新 status bar） */
    onStateChange?: () => void
    /** 轮询异常回调（会话过期等） */
    onError?: (err: unknown) => void
    /** 每次轮询迭代的心跳续约（全局锁） */
    heartbeat?: () => void
    /** 每批消息拉取即推送实例：上报 messageId + 最新游标（推送即消费，跨实例/跨机去重）。
     *  返回应丢弃的 messageId（已被其他实例消费过的重投消息）。 */
    onBatchFetched?: (messageIds: string[], cursor: string) => string[]
  }) {}

  get running(): boolean {
    return this._running
  }

  // --- IGateway 实现 ---

  onInbound(h: (m: InboundMessage) => void): void {
    this.inbound = h
  }

  async connect(): Promise<void> {
    this.client = this.deps.getClient()
    if (!this.client) throw new Error('微信客户端未登录')
    this._running = true
    this.pollAbort = new AbortController()
    void this.pollLoop().catch((err) => this.deps.onError?.(err))
  }

  async disconnect(): Promise<void> {
    this._running = false
    this.pollAbort?.abort()
    this.pollAbort = null
  }

  async send(target: string, m: OutboundMessage): Promise<void> {
    const client = this.deps.getClient()
    if (!client) return
    if (m.text) {
      await client.sendText(target, m.text)
    }
    for (const att of m.attachments ?? []) {
      if (att.kind === 'image') await client.sendImage(target, att.path)
      else if (att.kind === 'file') await client.sendFile(target, att.path, att.name)
    }
  }

  async fetchAttachment(_ref: unknown): Promise<Buffer | null> {
    // 微信图片已由 queue 预下载为 base64，附件引用不在 hub 侧使用
    return null
  }

  handleUserMessage(m: InboundMessage): void {
    this.deps.handleUserMessage(m)
  }

  isAwaitingAnswer(userId: string): boolean {
    return this.deps.isAwaitingAnswer?.(userId) ?? false
  }

  // --- 内部：iLink 轮询 ---

  private async pollLoop(): Promise<void> {
    const POLL_RETRY_BASE_MS = 2000
    const POLL_RETRY_MAX_MS = 30_000
    let retryDelay = POLL_RETRY_BASE_MS
    while (this._running) {
      const client = this.deps.getClient()
      if (!client) break
      // 每次迭代心跳续约全局锁（capability=wechat），TTL 10s，轮询间隔 2s 足够
      this.deps.heartbeat?.()
      try {
        const messages = await client.getUpdates(this.pollAbort?.signal)
        retryDelay = POLL_RETRY_BASE_MS
        if (messages.length > 0) {
          // 推送即消费：先上报（持久化游标 + 标记已消费），再按返回值丢弃其他实例已消费的重投消息
          const skip = new Set(
            this.deps.onBatchFetched?.(messages.map(m => m.messageId), client.cursorValue) ?? [],
          )
          for (const raw of messages) {
            if (skip.has(raw.messageId)) continue
            this.emitInbound(raw)
          }
        }
      } catch (err) {
        if (!this._running) break
        if (isAbortError(err)) break
        this.deps.onError?.(err)
        await sleep(retryDelay)
        retryDelay = Math.min(retryDelay * 2, POLL_RETRY_MAX_MS)
      }
    }
  }

  private emitInbound(raw: {
    messageId: string
    userId: string
    text: string
    type: string
    imageUrls: Array<{ url: string; aesKey?: string }>
    fileEncryptParam?: string
    fileAesKey?: string
    fileName?: string
    timestamp: Date
    raw: unknown
  }): void {
    if (!this.inbound) return
    const attachments: InboundMessage['attachments'] = []
    for (const img of raw.imageUrls) {
      attachments.push({ kind: 'image', ref: img })
    }
    if (raw.fileEncryptParam) {
      attachments.push({ kind: 'file', ref: { param: raw.fileEncryptParam, aesKey: raw.fileAesKey, name: raw.fileName } })
    }
    this.inbound({
      id: raw.messageId,
      channel: 'wechat',
      userId: raw.userId,
      text: raw.text || undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      ts: raw.timestamp.getTime(),
      // 保留原始 IncomingMessage 供渠道 handleUserMessage 恢复完整上下文
      rawMessage: raw,
    })
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
