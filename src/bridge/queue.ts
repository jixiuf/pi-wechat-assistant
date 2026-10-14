// ============================================================================
// 消息队列 + 批处理
// ============================================================================

import { randomUUID } from 'node:crypto'
import { Semaphore } from '../semaphore.js'
import type { ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { debugLog } from '../shared/logger.js'
import { WeixinClient } from '../wechat/client.js'
import { fetchImageAsBase64, fetchFile, saveFileToDisk, type ImageData } from '../wechat/media.js'
import {
  MAX_IMAGE_PREFETCH_CONCURRENCY,
} from '../shared/constants.js'
import { summarizePreview, formatError, extractTextFromMessageContent } from '../shared/utils.js'
import { redactUrl } from '../shared/logger.js'
import type { IncomingMessage } from '../wechat/types.js'
import { getConfigCache } from './config.js'
import { resolveImageBatchWaitMs, resolveImageMaxBytes, receiptText } from './config-values.js'
import { markWechatSource, WECHAT_SOURCE_TAG, DEFAULT_WECHAT_BLOCKED_TOOLS, type WechatUserContent } from '../messaging/wechat-source.js'
import {
  formatQuestionMessage,
  getQuestionTimeoutMs,
  parseQuestionAnswer,
  type ParsedQuestionAnswer,
  type QuestionOption,
} from '../questionnaire.js'
// --- 类型 ---

export interface QueuedMessage {
  id: string
  userId: string
  messageId: string
  receivedAt: Date
  text: string
  preview: string
  contextToken: string
  imageUrl?: string
  imageAesKey?: string
  imageData?: ImageData
  fileEncryptParam?: string
  fileAesKey?: string
  fileName?: string
  fileBuffer?: Buffer
  replyProfile?: { blockedTools: string[] }
}

export type Ctx = ExtensionContext | ExtensionCommandContext

/** 待答问题状态（等待微信用户回复） */
interface PendingQuestion {
  userId: string
  options: QuestionOption[]
  multiSelect: boolean
  resolve: (answer: ParsedQuestionAnswer | null) => void
}

// --- 配置读取（同步，基于内存缓存） ---

// Keep the existing queue exports as compatibility wrappers.
export function getImageBatchWaitMs(): number { return resolveImageBatchWaitMs(getConfigCache()) }
export function getImageMaxBytes(): number { return resolveImageMaxBytes(getConfigCache()) }

// --- 队列管理器 ---

export class MessageQueue {
  readonly queue: QueuedMessage[] = []
  pendingInjection: QueuedMessage | null = null
  activeRequest: QueuedMessage | null = null
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private imageBatchAckSent = false
  private _draining = false
  private generation = 0
  private fileDownloads = new Set<Promise<void>>()

  /** 待答问题（非空时目标用户的文本消息会被拦截为答案，不进入队列） */
  pendingQuestion: PendingQuestion | null = null

  get pendingQuestionUserId(): string | null {
    return this.pendingQuestion?.userId ?? null
  }

  /** 待注入的已保存文件列表（文件不进入队列和 AI 注入，等文字/图片触发时拼接） */
  private accumulatedFiles: Array<{ name: string; size: number; path: string }> = []

  /** 最后对话的微信用户（用于桥接双向同步） */
  lastWechatUser: { userId: string; contextToken: string } | null = null

  /** 图片预下载并发信号量 */
  private readonly _prefetchSemaphore = new Semaphore(MAX_IMAGE_PREFETCH_CONCURRENCY)

  constructor(
    private readonly getClient: () => WeixinClient | null,
    private readonly isRunning: () => boolean,
    private readonly getAgentIdle: () => boolean,
    private readonly getPollSignal: () => AbortSignal | undefined,
    private readonly getWechatFilesDir: () => string | null,
    private readonly sendUserMessage: (
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>,
      opts?: { deliverAs: 'steer' },
    ) => void,
    private readonly updateStatusBar: () => void,
    private readonly canSubmit: () => boolean = () => true,
  ) {}

  // --- 入队 ---

  enqueue(message: IncomingMessage): void {
    const log = debugLog
    const imageCount = message.imageUrls.length
    const hasImages = imageCount > 0
    const hasText = !!message.text
    const hasFile = !!message.fileEncryptParam
    log(`[ENQUEUE] type=${message.type} text=${message.text?.slice(0, 40)} images=${imageCount} hasFile=${hasFile} queueBefore=${this.queue.length} agentIdle=${this.getAgentIdle()} batchTimer=${!!this.batchTimer}`)

    const client = this.getClient()

    const base = {
      userId: message.userId,
      messageId: message.messageId,
      receivedAt: message.timestamp,
      contextToken: message.contextToken,
    }

    // 文件：立即下载保存 + 自动回复，不入队，不参与计时器
    if (hasFile) {
      const download = this._handleFile(message, this.generation).catch(error => {
        log(`[FILE-ERROR] ${formatError(error)}`)
      })
      this.fileDownloads.add(download)
      void download.finally(() => this.fileDownloads.delete(download))
    }

    // 文字部分
    if (hasText) {
      this.queue.push({
        id: randomUUID(),
        ...base,
        text: message.text,
        preview: summarizePreview(message.text),
      })
    }

    // 图片部分 — 每张图一个 QueuedMessage（批处理会合并）
    for (const img of message.imageUrls) {
      const request: QueuedMessage = {
        id: randomUUID(),
        ...base,
        text: '',
        preview: '[图片]',
        imageUrl: img.url,
        imageAesKey: img.aesKey,
      }
      this.queue.push(request)
      void this.prefetchImage(request)
    }

    this.lastWechatUser = { userId: message.userId, contextToken: message.contextToken }
    log(`[ENQUEUE-DONE] text=${hasText} images=${imageCount} file=${hasFile} queueAfter=${this.queue.length} accumulatedFiles=${this.accumulatedFiles.length}`)
    this.updateStatusBar()

    // 只有文字 → 立即 drain（顺便带上累积的文件）
    if (hasText) {
      if (this.batchTimer) {
        clearTimeout(this.batchTimer)
        this.batchTimer = null
        log(`[ENQUEUE-TEXT] batch timer was active, will drain immediately`)
      } else {
        log(`[ENQUEUE-TEXT] no batch timer, calling drainQueue directly`)
      }
      void this.drain()
      return
    }

    // 纯图片 → 批处理 ack + 计时器
    if (hasImages) {
      if (!this.imageBatchAckSent && client && getConfigCache().sendAck !== false) {
        this.imageBatchAckSent = true
        void client.sendText(message.userId, receiptText(getConfigCache(), true)).catch(err => log(`[IMAGE-ACK-FAIL] ${formatError(err)}`))
      }
      this.restartBatchTimer('图片')
      return
    }

    // 纯文件（无文字无图片）→ 已自动保存，不做任何注入
    log(`[ENQUEUE-FILE-ONLY] file saved, no AI injection`)
  }

  /** 文件处理：下载 → 保存到项目目录 → 自动回复 → 累积 */
  private async _handleFile(message: IncomingMessage, generation: number): Promise<void> {
    const log = debugLog
    const client = this.getClient()
    const fileName = message.fileName ?? '未知文件'

    const buffer = await fetchFile(message.fileEncryptParam!, message.fileAesKey, this.getPollSignal())
    if (generation !== this.generation || !this.isRunning()) return
    if (!buffer) {
      log(`[FILE-DL-FAIL] ${fileName}`)
      if (client) void client.sendText(message.userId, `⚠️ 文件下载失败: ${fileName}`).catch(() => {})
      return
    }

    const wechatFilesDir = this.getWechatFilesDir()
    if (!wechatFilesDir) {
      log(`[FILE-SAVE-FAIL] wechatFilesDir 未设置`)
      return
    }
    const savedPath = await saveFileToDisk(buffer, fileName, wechatFilesDir)
    if (generation !== this.generation || !this.isRunning()) return
    if (!savedPath) {
      log(`[FILE-SAVE-FAIL] 保存失败: ${fileName}`)
      return
    }

    this.accumulatedFiles.push({ name: fileName, size: buffer.length, path: savedPath })
    log(`[FILE-SAVED] ${fileName} (${(buffer.length / 1024).toFixed(1)} KB) → ${savedPath}`)

    if (client) {
      const kb = (buffer.length / 1024).toFixed(1)
      void client.sendText(message.userId, `✅ 已保存: ${fileName} (${kb} KB)`).catch(() => {})
    }
  }

  private restartBatchTimer(label: string): void {
    const waitMs = getImageBatchWaitMs()
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      debugLog(`${label}批处理计时器到期`)
      void this.drain()
    }, waitMs)
    debugLog(`${label}批处理计时器已设置: ${waitMs / 1000}s`)
  }

  // --- 预下载（带并发控制） ---

  async prefetchImage(request: QueuedMessage): Promise<void> {
    if (!request.imageUrl) return
    await this._prefetchSemaphore.acquire()
    try {
      const imageData = await fetchImageAsBase64(request.imageUrl, request.imageAesKey, getImageMaxBytes(), this.getPollSignal())
      request.imageData = imageData ?? undefined
      debugLog(`图片预下载: ${imageData ? `success, size=${imageData.data.length}` : 'failed'}`)
    } finally {
      this._prefetchSemaphore.release()
    }
  }

  // --- 待答问题（微信选项式问卷） ---

  /**
   * 通过微信向指定用户提问，挂起等待回复。
   * 返回 null 表示超时 / 被取消 / 桥接不可用。
   */
  askQuestion(opts: {
    userId: string
    question: string
    header?: string
    options: QuestionOption[]
    multiSelect?: boolean
    index?: number
    total?: number
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<ParsedQuestionAnswer | null> {
    const client = this.getClient()
    if (!client || !this.isRunning()) return Promise.resolve(null)

    // 上一个未完成的问题先取消
    this.cancelPendingQuestion()

    return new Promise((resolve) => {
      const userId = opts.userId
      const timeoutMs = opts.timeoutMs ?? getQuestionTimeoutMs()
      let settled = false
      let pending: PendingQuestion
      let timer: ReturnType<typeof setTimeout>

      const settle = (answer: ParsedQuestionAnswer | null): void => {
        if (settled) return
        settled = true
        if (this.pendingQuestion === pending) this.pendingQuestion = null
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        resolve(answer)
      }

      const onAbort = (): void => settle(null)

      timer = setTimeout(() => {
        void client.sendText(userId, '⏰ 等待回复超时，问题已取消').catch(() => {})
        settle(null)
      }, timeoutMs)

      pending = {
        userId,
        options: opts.options,
        multiSelect: opts.multiSelect ?? false,
        resolve: settle,
      }
      this.pendingQuestion = pending
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      // 发送问题文本（发送失败立即取消）
      const text = formatQuestionMessage(opts)
      client.sendText(userId, text).catch((err) => {
        debugLog(`[QUESTION-SEND-FAIL] ${formatError(err)}`)
        settle(null)
      })
    })
  }

  /**
   * 尝试把微信文本消息作为待答问题的答案消费。
   * 返回 true 表示已消费（消息不再进入正常队列）。
   */
  answerPendingQuestion(userId: string, text: string): boolean {
    const pending = this.pendingQuestion
    if (!pending || pending.userId !== userId) return false

    const parsed = parseQuestionAnswer(text, pending.options, pending.multiSelect)

    if (parsed.kind === 'invalid') {
      // 数字越界或空文本 → 提示重发，不结束等待
      const hint = pending.multiSelect
        ? '⚠️ 请输入有效选项数字（如 1,3），或直接输入自定义文字；回复 0 取消'
        : '⚠️ 请输入有效选项数字，或直接输入自定义文字；回复 0 取消'
      void this.getClient()?.sendText(userId, hint).catch(() => {})
      return true
    }

    if (parsed.kind === 'cancel') {
      void this.getClient()?.sendText(userId, '✖️ 问题已取消').catch(() => {})
    }
    pending.resolve(parsed)
    return true
  }

  /** 取消当前待答问题（resolve null，不消费任何消息） */
  cancelPendingQuestion(): void {
    const pending = this.pendingQuestion
    if (!pending) return
    pending.resolve(null)
  }

  // --- 队列排出 ---

  async drain(): Promise<void> {
    const log = debugLog

    // 防重入保护
    if (this._draining) { log(`[DRAIN-SKIP] already draining`); return }
    this._draining = true
    const generation = this.generation

    try {
      await this._doDrain()
    } catch (error) {
      if (generation !== this.generation) return
      // 兜底：reload/newSession 后旧 ctx 的 pi 调用会同步 throw（assertActive），
      // 任何漏网的异常都不能变成 unhandledRejection（会导致 Node 进程退出）。
      log(`[DRAIN-ERROR] ${formatError(error)}`)
      const request = this.pendingInjection
      this.pendingInjection = null
      if (request) {
        void this.getClient()?.stopTyping(request.userId).catch(() => {})
        void this.getClient()?.sendText(request.userId, '⚠️ 消息投递失败，请重新发送。').catch(() => {})
      }    } finally {
      if (generation !== this.generation) return
      this._draining = false
      // Messages received during downloads or the acknowledgement must not wait
      // for agent_end if this run can accept a follow-up already.
      if (this.queue.length && this.isRunning() && this.getClient() && !this.pendingInjection && !this.batchTimer && this.canSubmit()) {
        setImmediate(() => void this.drain())
      }
    }
  }

  private async _doDrain(): Promise<void> {
    const log = debugLog
    const client = this.getClient()

    log(`[DRAIN-ENTER] running=${this.isRunning()} client=${!!client} queue=${this.queue.length} pendingInjection=${!!this.pendingInjection} activeRequest=${!!this.activeRequest} agentIdle=${this.getAgentIdle()} batchTimer=${!!this.batchTimer}`)
    if (!this.isRunning() || !client) { log(`[DRAIN-SKIP] not running or no client`); return }
    if (this.pendingInjection) { log(`[DRAIN-SKIP] pendingInjection already set`); return }
    if (this.batchTimer) { log(`[DRAIN-SKIP] 批处理计时器运行中`); return }
    if (!this.canSubmit()) { log(`[DRAIN-SKIP] agent preparing`); return }
    if (this.queue.length === 0) { log(`[DRAIN-SKIP] queue empty`); return }

    // File and text parts may arrive together. Wait for the current downloads so
    // their saved paths accompany this batch, rather than a later unrelated turn.
    const generation = this.generation
    await Promise.all([...this.fileDownloads])
    if (generation !== this.generation || !this.isRunning() || !this.canSubmit() || this.batchTimer) return

    const batch = this.queue.splice(0)
    if (batch.length === 0) { log(`[DRAIN-SKIP] queue empty after splice`); return }

    const pendingFiles = this.accumulatedFiles.splice(0)

    log(`[DRAIN-BATCH] msgs=${batch.length} pendingFiles=${pendingFiles.length}`)
    this.imageBatchAckSent = false
    this.updateStatusBar()

    const first = batch[0]
    const isBusy = !this.getAgentIdle()

    if (!isBusy) {
      this.pendingInjection = first
      log(`[DRAIN-PEND] pendingInjection set`)
    } else {
      log(`[DRAIN-BUSY-DELIVER] agent busy, will use steer`)
    }
    void client.startTyping(first.userId).catch(() => {})

    const texts: string[] = []
    const images: ImageData[] = []
    const files: Array<{ name: string; path: string; size: number }> = [...pendingFiles]

    for (const msg of batch) {
      if (msg.text) texts.push(msg.text)
      if (msg.imageData) {
        images.push(msg.imageData)
      } else if (msg.imageUrl) {
        log(`现场下载图片: ${redactUrl(msg.imageUrl)}`)
        const imageData = await fetchImageAsBase64(msg.imageUrl, msg.imageAesKey, getImageMaxBytes(), this.getPollSignal())
        if (imageData) images.push(imageData)
      }
    }
    if (generation !== this.generation || !this.isRunning()) return
    if (!this.canSubmit()) {
      this.queue.unshift(...batch)
      this.accumulatedFiles.unshift(...files)
      this.pendingInjection = null
      void client.stopTyping(first.userId).catch(() => {})
      return
    }

    const hasImages = images.length > 0
    const hadImageMessages = batch.some(msg => !!msg.imageUrl)
    const hasFiles = files.length > 0
    const hasText = texts.length > 0

    // 来源标识 + 工具黑名单（upstream wechat-source 模型）：微信回合的消息打上
    // [微信] 标记并禁用 TUI 提问工具，系统提示词里的条件规则据此生效
    const sourceConfig = getConfigCache().messageSourceTag
    const sourceEnabled = sourceConfig?.enabled !== false
    if (sourceEnabled) {
      first.replyProfile = { blockedTools: [...(sourceConfig?.blockedTools ?? DEFAULT_WECHAT_BLOCKED_TOOLS)] }
    }
    const markContent = (content: WechatUserContent): WechatUserContent =>
      sourceEnabled ? markWechatSource(content, sourceConfig?.wechatTag?.trim() || WECHAT_SOURCE_TAG) : content

    // 拼接文件信息
    let fileNote = ''
    if (hasFiles) {
      const fileInfos = files.map(f =>
        `- 文件「${f.name}」(${(f.size / 1024).toFixed(1)} KB)，已保存到: ${f.path}`
      ).join('\n')
      fileNote = hasText
        ? `\n\n用户通过微信发送了 ${files.length} 个文件：\n${fileInfos}`
        : `用户通过微信发送了 ${files.length} 个文件：\n${fileInfos}`
    }

    if (hasFiles && !hasImages && !hasText) {
      log(`[DRAIN-FILES-ONLY] no text or images, skipping AI injection`)
      this.accumulatedFiles.unshift(...files)
      this.pendingInjection = null
      void client.stopTyping(first.userId).catch(() => {})
      this.updateStatusBar()
      return
    }

    if (hasFiles) {
      const combinedText = texts.join('\n') + fileNote
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: combinedText }]
      for (const img of images) content.push({ type: 'image', data: img.data, mimeType: img.mediaType })
      const deliverOpts = { deliverAs: 'steer' as const }
      log(`[DRAIN-SEND] file+text, files=${files.length}, images=${images.length}, mode=${deliverOpts.deliverAs}`)
      if (!this.deliverToPi(markContent(content), deliverOpts, log, client, first.userId)) return
    } else if (hasImages) {
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
      if (!hasText) {
        content.push({ type: 'text', text: (images.length === 1 ? '请帮我分析这张图片' : `请帮我分析这 ${images.length} 张图片`) })
      } else {
        content.push({ type: 'text', text: texts.join('\n') })
      }
      for (const img of images) content.push({ type: 'image', data: img.data, mimeType: img.mediaType })
      const deliverOpts = { deliverAs: 'steer' as const }
      log(`[DRAIN-SEND] image+text, images=${images.length}, mode=${deliverOpts.deliverAs}`)
      if (!this.deliverToPi(markContent(content), deliverOpts, log, client, first.userId)) return
    } else if (hasText) {
      // 恒带 deliverAs:'steer'：扩展侧 agentIdle 与核心 isStreaming 存在竞态窗口（agent_start/end 事件异步派发），
      // 误判空闲时不带 streamingBehavior 会被核心抛 "Agent is already processing"。空闲时核心忽略该字段，行为不变。
      const deliverOpts = { deliverAs: 'steer' as const }
      log(`[DRAIN-SEND] text, text=${texts.join(' ').slice(0, 80)}, mode=${deliverOpts.deliverAs}`)
      if (!this.deliverToPi(markContent(texts.join('\n')), deliverOpts, log, client, first.userId)) return
    } else {
      if (hadImageMessages) {
        const limitMB = Math.round(getImageMaxBytes() / 1024 / 1024)
        await client.sendText(first.userId, `⚠️ 图片下载失败、格式不支持或超过大小限制（当前上限 ${limitMB}MB）。`).catch(() => {})
      }
      this.pendingInjection = null
      void client.stopTyping(first.userId).catch(() => {})
      // 重新调度 drain，使用 setImmediate 代替 setTimeout(0) 避免堆叠
      setImmediate(() => void this.drain())
      return
    }

    if (!hadImageMessages && getConfigCache().sendAck !== false) {
      try {
        await client.sendText(first.userId, receiptText(getConfigCache()))
      } catch (err) {
        log(`发送回执失败: ${formatError(err)}`)
      }
    }
  }

  /**
   * 投递消息给 pi（触发 agent 处理）。
   * reload/newSession 后旧扩展的 pi API 会变 stale，sendUserMessage 同步 throw（assertActive）。
   * 这里捕获异常并清理队列状态，避免 unhandledRejection 崩溃以及
   * pendingInjection 残留导致后续 drain 卡死。
   * 返回 false 表示投递失败，调用方应中止本轮 drain（不再发回执）。
   */
  private deliverToPi(
    content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>,
    deliverOpts: { deliverAs: 'steer' } | undefined,
    log: typeof debugLog,
    client: WeixinClient,
    userId: string,
  ): boolean {
    try {
      this.sendUserMessage(content, deliverOpts)
      return true
    } catch (err) {
      log(`[DRAIN-SEND-FAIL] deliver to pi failed (stale ctx after reload/newSession?): ${formatError(err)}`)
      this.pendingInjection = null
      void client.stopTyping(userId).catch(() => {})
      return false
    }
  }

  // --- 统一发送到微信 ---

  reset(): void {
    this.cancelPendingQuestion()
    this.queue.length = 0
    this.pendingInjection = null
    this.activeRequest = null
    this.generation++
    this.fileDownloads.clear()
    this.imageBatchAckSent = false
    this.accumulatedFiles = []
    this._draining = false
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null }
  }

  get pending(): number {
    return this.queue.length
  }
}
