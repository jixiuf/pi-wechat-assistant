// ============================================================================
// pi-wechat-assistant — 微信作为 pi TUI 的移动端分身
// ============================================================================

import * as fs from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Type } from '@sinclair/typebox'
// @ts-ignore — @earendil-works is the current package, but the older package still carries TS declarations used for compatibility here
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
// @ts-ignore — @earendil-works is the current package, but the older package still carries TS declarations used for compatibility here
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { SessionExpiredError, WeixinClient } from './client.js'
import { acquireLock, releaseLock, loadCredentials, loadConfig } from './auth.js'
import { debugLog, isDebugEnabled } from './logger.js'
import { splitAndFilterMarkdown } from './message.js'
import { MessageQueue } from './queue.js'
import { handleRemoteCommand, type RemoteCommandDeps } from './remote-commands.js'
import { registerCommands, type CommandDeps } from './commands.js'
import { WechatGateway } from './gateway.js'
import { ok, fail, formatError, isAbortError, extractAllAssistantReplies, extractTextFromMessageContent } from './utils.js'
import type { WechatQuestionBridge } from './questionnaire.js'
import {
  POLL_RETRY_BASE_MS,
  POLL_RETRY_MAX_MS,
  UNSUPPORTED_TYPES,
  UNSUPPORTED_REPLY,
  WECHAT_FILES_SUBDIR,
} from './constants.js'
import type { IncomingMessage } from './types.js'

type Ctx = ExtensionContext | ExtensionCommandContext

// ============================================================================
// TurnContext — 单轮对话会话状态
// ============================================================================

class TurnContext {
  seq = 0
  wechatConversationActive = false
  targetUser: string | null = null
  sentCount = 0
  messages: Array<{ role?: string; content?: unknown }> | null = null
  ended = false

  reset(): void {
    this.wechatConversationActive = false
    this.targetUser = null
    this.sentCount = 0
    this.messages = null
    this.ended = false
  }
}

// ============================================================================
// 路径沙箱校验
// ============================================================================

function isPathInCwd(targetPath: string, cwd: string): boolean {
  const resolved = path.resolve(targetPath)
  const resolvedCwd = path.resolve(cwd)
  return resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd
}

// ============================================================================
// 工具守卫 — 发送文件/图片到微信的前置校验
// ============================================================================

type ToolGuardResult = {
  allowed: false
  error: ReturnType<typeof fail>
} | {
  allowed: true
  resolvedPath: string
  cwd: string
}

function guardSendToWechat(
  client: WeixinClient | null,
  running: boolean,
  lastWechatUser: { userId: string } | null,
  filePath: string,
  latestCtx: Ctx | null,
): ToolGuardResult {
  if (!client) return { allowed: false, error: fail('微信未登录，请先在 TUI 执行 /wechat login 和 /wechat start') }
  if (!running) return { allowed: false, error: fail('微信桥接未启动，请先在 TUI 执行 /wechat start') }
  if (!lastWechatUser) return { allowed: false, error: fail('尚未收到微信用户消息，无法获取 context_token。请先让微信用户发送一条消息。') }

  const cwd = latestCtx?.cwd ?? process.cwd()
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)

  if (!isPathInCwd(resolvedPath, cwd)) {
    return {
      allowed: false,
      error: fail(`安全限制：只能发送项目目录内的文件。\n路径: ${resolvedPath}\n项目: ${path.resolve(cwd)}`),
    }
  }
  if (!existsSync(resolvedPath)) return { allowed: false, error: fail(`文件不存在: ${resolvedPath}`) }

  return { allowed: true, resolvedPath, cwd }
}

function guardFileSize(resolvedPath: string): ReturnType<typeof fail> | null {
  try {
    const stats = statSync(resolvedPath)
    if (stats.size > 50 * 1024 * 1024) {
      return fail(`文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，上限 50MB`)
    }
    return null
  } catch {
    return fail(`无法读取文件: ${resolvedPath}`)
  }
}

// ============================================================================
// Extension
// ============================================================================

export default function wechatAssistant(pi: ExtensionAPI) {
  let client: WeixinClient | null = null
  let running = false
  let agentIdle = true
  let currentInstanceName = 'local'
  let pollAbort: AbortController | null = null
  let latestCtx: Ctx | null = null
  let wechatFilesDir: string | null = null

  const turn = new TurnContext()
  let lockSessionId: string | null = null

  // --- 消息队列 ---
  const queue = new MessageQueue(
    () => client,
    () => running,
    () => agentIdle,
    () => pollAbort?.signal,
    () => wechatFilesDir,
    (content, opts) => pi.sendUserMessage(content as any, opts),
    updateStatusBar,
  )

  // --- 通知 ---

  function log(message: string): void { debugLog(message) }

  function notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (latestCtx?.hasUI) {
      latestCtx.ui.notify(message, level)
      if (!isDebugEnabled()) return
    }
    const printer = level === 'error' ? console.error : console.log
    printer(`[wechat-assistant/${level}] ${message}`)
  }

  function updateStatusBar(): void {
    if (!latestCtx?.hasUI) return
    if (!client && !running) { latestCtx.ui.setStatus('wechat', ''); return }
    if (running) {
      const pending = queue.pending
      latestCtx.ui.setStatus('wechat', `[微信 ✅ 已连接${pending > 0 ? ` | 待处理:${pending}` : ''}]`)
    } else if (client) {
      latestCtx.ui.setStatus('wechat', '[微信 ⏸ 未连接]')
    } else {
      latestCtx.ui.setStatus('wechat', '[微信 ❌ 未登录]')
    }
  }

  // --- 锁：优先 hub 全局锁（跨机互斥），hub 不可用时降级本地锁（同机互斥） ---

  function getLockId(): string {
    if (!lockSessionId) lockSessionId = `pi-wechat-${process.pid}-${Date.now().toString(36)}`
    return lockSessionId
  }

  interface HubBridge {
    coordinatorTryLock?: (name: string, pid: number, capability?: string, force?: boolean) => boolean
    coordinatorReleaseLock?: (name: string, capability?: string, pid?: number) => void
    getInstanceName?: () => string
    getCoordinatorUrl?: () => string | undefined
    requestRemoteLock?: (
      baseUrl: string, name: string, pid: number, capability?: string, force?: boolean,
    ) => Promise<{ ok: boolean; unreachable?: boolean; holder?: { name?: string } | null }>
    releaseRemoteLock?: (baseUrl: string, name: string, capability?: string) => Promise<void>
  }

  function getHubBridge(): HubBridge | null {
    return ((globalThis as Record<string, unknown>).__PI_HUB__ ?? null) as HubBridge | null
  }

  /** 锁持有者名：优先 hub 实例名（保证与协调中心一致），否则本机 cwd 名 */
  function getLockHolderName(): string {
    return getHubBridge()?.getInstanceName?.() || currentInstanceName || 'local'
  }

  /** 客户端模式：协调中心 URL 存在时锁走远程 HTTP（跨机唯一仲裁）；否则本地锁 */
  function getCoordUrl(): string | undefined {
    return getHubBridge()?.getCoordinatorUrl?.()
  }

  async function lock(): Promise<{ success: boolean; message: string }> {
    const hub = getHubBridge()
    const coordUrl = getCoordUrl()
    const holderName = getLockHolderName()
    if (coordUrl && hub?.requestRemoteLock) {
      // 客户端 → 协调中心请求全局锁（服务器端唯一仲裁）
      const res = await hub.requestRemoteLock(coordUrl, holderName, process.pid, 'wechat')
      if (res.ok) {
        lockSessionId = getLockId()
        return { success: true, message: '已获取全局锁' }
      }
      if (res.unreachable) {
        // 协调中心不可达（服务器 pi 可能已停）→ 降级本地锁接管，不让位
        log(`协调中心不可达，降级本地锁接管微信`)
        if (hub.coordinatorTryLock?.(holderName, process.pid, 'wechat')) {
          lockSessionId = getLockId()
          return { success: true, message: '协调中心不可达，已本地接管' }
        }
        return { success: false, message: '本地锁获取失败' }
      }
      const holder = res.holder?.name
      return { success: false, message: `微信已被其他实例接管 (${holder ?? '未知'})` }
    }
    if (hub?.coordinatorTryLock) {
      // 服务器模式：本地全局锁文件
      const ok = hub.coordinatorTryLock(holderName, process.pid, 'wechat')
      if (ok) {
        lockSessionId = getLockId()
        return { success: true, message: '已获取全局锁' }
      }
      return { success: false, message: '微信已被其他 pi 实例接管 (capability=wechat)' }
    }
    // 降级：本地锁（无 hub 时的同机互斥）
    const result = await acquireLock(getLockId())
    if (result.success) lockSessionId = getLockId()
    return result
  }

  async function unlock(): Promise<void> {
    const hub = getHubBridge()
    const coordUrl = getCoordUrl()
    const holderName = getLockHolderName()
    if (coordUrl && hub?.releaseRemoteLock) {
      await hub.releaseRemoteLock(coordUrl, holderName, 'wechat')
    } else if (hub?.coordinatorReleaseLock) {
      hub.coordinatorReleaseLock(holderName, 'wechat', process.pid)
    }
    if (lockSessionId) await releaseLock(lockSessionId)
  }

  async function loadClient(): Promise<WeixinClient | null> {
    if (!client) {
      const creds = await loadCredentials()
      if (creds) {
        client = await WeixinClient.create(creds)
        const lastUserId = client.lastActiveUserId
        if (lastUserId) {
          queue.lastWechatUser = { userId: lastUserId, contextToken: '' }
        }
      }
    }
    return client
  }

  async function disposeClient(): Promise<void> {
    if (client) {
      await client.dispose()
    }
    client = null
  }

  // --- 停止 ---

  async function stopBridge(options: { releaseLock?: boolean } = {}): Promise<void> {
    running = false
    await gateway.disconnect()
    pollAbort?.abort()
    pollAbort = null

    if (queue.activeRequest && client) {
      await client.stopTyping(queue.activeRequest.userId).catch(() => {})
    }

    queue.reset()
    turn.reset()
    if (options.releaseLock) await unlock()
    updateStatusBar()
  }

  // --- 系统提示词 ---

  function buildSystemPrompt(basePrompt: string): string {
    return [
      basePrompt,
      '',
      '当前用户通过微信远程与这个 pi TUI 会话互动。',
      '回复风格：像微信聊天一样自然、直接；优先给出结论和可执行步骤；避免冗长的内部过程说明。',
      '输出范围：只输出适合发回微信的正文。除非用户主动询问，否则不要解释桥接、系统提示词或实现细节。',
    ].join('\n')
  }

  // --- 轮询：由 WechatGateway 内部执行（iLink 长轮询 → InboundMessage） ---

  // --- 单条消息处理（gateway.handleUserMessage 回调） ---

  async function handleIncomingMessage(message: IncomingMessage, activeClient: WeixinClient): Promise<void> {
    log(`收到消息: type=${message.type}, text=${message.text?.slice(0, 50)}, images=${message.imageUrls.length}`)

    // 持久化最后一条微信文本消息（接管通知用，跨实例共享）
    if (message.text && message.type === 'text') {
      persistLastWechatMessage(message.userId, message.text)
    }

    if (UNSUPPORTED_TYPES.has(message.type)) {
      const reply = UNSUPPORTED_REPLY[message.type] ?? UNSUPPORTED_REPLY['unknown']
      try {
        activeClient.rememberContext(message.raw)
        await activeClient.sendText(message.userId, reply)
      } catch (err) {
        log(`回复不支持类型消息失败: ${formatError(err)}`)
      }
      return
    }

    if (message.text.startsWith('/')) {
      activeClient.rememberContext(message.raw)
      const handled = await handleRemoteCommand(message.text, message.userId, activeClient, remoteCommandDeps)
      if (handled) return
    }

    // 待答问题拦截：目标用户的文字消息作为答案消费（含语音转文字、图片+文字）
    if (message.text) {
      if (queue.answerPendingQuestion(message.userId, message.text)) {
        log(`[QUESTION-ANSWER] consumed text as answer from ${message.userId}`)
        return
      }
    } else if (queue.pendingQuestionUserId === message.userId) {
      // 等待答案期间收到无文字消息（纯图片/文件等）→ 提示重发，不消费
      log(`[QUESTION-ANSWER] non-text message while waiting, prompting retry`)
      try {
        await activeClient.sendText(message.userId, '⏳ 当前正在等待文字答案，请用文字回复（回复 0 取消）')
      } catch (err) {
        log(`回复提示失败: ${formatError(err)}`)
      }
      return
    }

    queue.enqueue(message)
  }

  // --- WechatGateway：iLink 轮询 → InboundMessage → hub（协调命令）→ handleUserMessage（渠道处理） ---

  const gateway = new WechatGateway({
    getClient: () => client,
    handleUserMessage: (m) => {
      // 会话命令（/model /status 等需 pi 上下文）由渠道处理；
      // 协调命令（/instances /use /msg 等）已由 hub 先消费，不会到这里
      void handleGatewayMessage(m)
    },
    // 问卷等待中：宽松 use 匹配（数字→切换）让位于问卷答案
    isAwaitingAnswer: (userId) => queue.pendingQuestionUserId === userId,
    onStateChange: () => updateStatusBar(),
    onError: (err) => {
      if (err instanceof SessionExpiredError) {
        notify('微信 Session 已过期，请执行 /wechat-login 重新登录', 'error')
        void stopBridge({ releaseLock: true })
        return
      }
      log(`轮询失败: ${formatError(err)}`)
    },
    heartbeat: () => {
      // 轮询迭代中续约全局锁（双保险，主心跳是独立定时器）
      lockHeartbeat()
    },
  })

  // --- 锁状态机 ---
  // 客户端（有 coordUrl）：远程锁优先；协调中心不可达时降级本地锁（临时），
  // 协调中心恢复后首个心跳重新仲裁：成功续约远程锁并清理本地锁，被占则让位。
  // 协调中心模式（无 coordUrl）：本地锁唯一持有者。

  /** 锁状态机：每 1s 运行一次。
   *  - 未连接：尝试获取锁（协调中心不可达→降级本地；空闲→接管启动轮询）
   *  - 已连接：续约锁（协调中心恢复→切远程清本地；被占→让位停止轮询）
   *  独立于轮询循环，保证协调中心故障/恢复都能及时收敛。
   */
  // 协调中心连续不可达计数：连续 3 次（3s）才降级本地锁，避免 reload 抖动误判
  let coordUnreachableCount = 0

  function lockHeartbeat(): void {
    const hub = getHubBridge()
    const coordUrl = getCoordUrl()
    const holderName = getLockHolderName()

    if (coordUrl && hub?.requestRemoteLock) {
      // 客户端模式：
      //  - 协调中心可达：若本机已持有则续约（锁归本机 pid）；否则不抢（协调中心模式实例负责接管）
      //  - 协调中心连续不可达：降级本地锁（唯一存活时接管）
      void hub.requestRemoteLock(coordUrl, holderName, process.pid, 'wechat').then((res) => {
        if (res.ok) {
          coordUnreachableCount = 0
          // 远程锁成功（获取或续约）：本机是持锁者，应启动/保持轮询
          clearLocalDegradedLock()
          if (!running) {
            log(`已获取协调中心锁，启动微信轮询`)
            startPolling()
          }
          return
        }
        if (res.unreachable) {
          coordUnreachableCount++
          // 协调中心连续不可达（≥3s，排除 reload 抖动）：降级本地锁
          if (coordUnreachableCount >= 3) {
            if (!running) {
              if (hub.coordinatorTryLock?.(holderName, process.pid, 'wechat')) {
                log(`协调中心持续不可达，降级本地锁接管微信`)
                startPolling()
              }
            } else {
              hub.coordinatorTryLock?.(holderName, process.pid, 'wechat')
            }
          }
          return
        }
        // 协调中心可达但锁被他人持有（或空闲）：
        coordUnreachableCount = 0
        if (running) {
          log(`全局锁已被其他实例接管，微信轮询让位`)
          clearLocalDegradedLock()
          void stopBridge({ releaseLock: false })
        }
      }).catch(() => {})
      return
    }
    if (hub?.coordinatorTryLock) {
      // 协调中心模式：本地锁唯一持有者
      const ok = hub.coordinatorTryLock(holderName, process.pid, 'wechat')
      if (ok) {
        if (!running) startPolling()
      } else if (running) {
        log(`全局锁已被其他实例接管，微信轮询让位`)
        void stopBridge({ releaseLock: false })
      }
    }
  }

  /** 清理本地降级锁（仅当锁归本进程时）——协调中心恢复后避免双锁 */
  function clearLocalDegradedLock(): void {
    const hub = getHubBridge()
    hub?.coordinatorReleaseLock?.(getLockHolderName(), 'wechat', process.pid)
  }

  // 独立心跳定时器：每 3s 运行锁状态机（不依赖 running，保证故障/恢复及时收敛）。
  // 降频：与 GLOBAL_LOCK_TTL_MS(15s) 匹配（余量 >=3 次），减少磁盘 IO 与协调中心 HTTP 请求。
  const heartbeatTimer = setInterval(() => lockHeartbeat(), 3000)

  /** gateway 入站消息 → 渠道内部处理（从 rawMessage 恢复完整 IncomingMessage） */
  async function handleGatewayMessage(m: {
    id: string
    userId: string
    text?: string
    attachments?: Array<{ kind: string; ref: unknown }>
    ts: number
    rawMessage?: unknown
  }): Promise<void> {
    if (!client) return
    const raw = m.rawMessage as
      | (IncomingMessage & { raw?: unknown })
      | undefined
    if (raw) {
      // hub 已消费协调命令；此处直接走渠道完整处理（含图片/文件/问卷）
      await handleIncomingMessage(raw, client)
      return
    }
    // 无原始消息（理论上不发生）：兜底构造文本消息
    const msg: IncomingMessage = {
      messageId: m.id,
      userId: m.userId,
      text: m.text ?? '',
      type: 'text',
      imageUrls: [],
      timestamp: new Date(m.ts),
      raw: {} as IncomingMessage['raw'],
      contextToken: '',
    }
    await handleIncomingMessage(msg, client)
  }

  // --- 远程命令依赖 ---

  const remoteCommandDeps: RemoteCommandDeps = {
    pi,
    getCtx: () => latestCtx,
    client: () => client,
    queueLength: () => queue.pending,
  }

  // --- TUI 命令注册 ---

  const startPolling = async (): Promise<void> => {
    if (running || !client) return
    running = true
    agentIdle = true
    pollAbort = new AbortController()
    notify('微信桥接已启动 📱', 'info')
    updateStatusBar()
    void gateway.connect().catch((err) => log(`gateway.connect 异常退出: ${formatError(err)}`))
    // 注意：不在这里通知微信用户。接管通知仅在明确的接管事件（onTakeoverRequest）触发，
    // 避免降级接管/autoStart/heartbeat 多路径重复通知。
  }

  /**
   * 接管/启动成功后通知最后活跃的微信用户：告知已由本实例接管，并附最后一条消息。
   * 用户感知不到实例切换，需主动告知。
   */
  // 接管通知防抖：同一实例 5s 内只通知一次（避免 heartbeat/接管分支竞态重复）
  let lastTakeoverNotify = 0
  async function notifyWechatTakeover(): Promise<void> {
    try {
      if (!client || !running) return
      const now = Date.now()
      if (now - lastTakeoverNotify < 5000) return
      lastTakeoverNotify = now
      const userId = client.lastActiveUserId ?? queue.lastWechatUser?.userId
      if (!userId) return
      const instanceLabel = currentInstanceName || 'local'
      const lastMsg = await getLastWechatMessage()
      const text = lastMsg
        ? `🔁 微信已由实例 ${instanceLabel} 接管\n\n最后一条对话：\n${lastMsg}`
        : `🔁 微信已由实例 ${instanceLabel} 接管`
      await client.sendText(userId, text)
      log(`已通知微信用户接管切换: ${instanceLabel}`)
    } catch (err) {
      log(`接管通知失败: ${formatError(err)}`)
    }
  }

  /** 持久化最后一条微信文本消息（接管通知用，跨实例共享） */
  interface LastWechatMsg { userId: string; userMsg: string; aiMsg: string; ts: number }

  /** hub 桥的 lastMsg 读写（协调中心模式本地/客户端模式远程，跨实例共享） */
  function getHubLastMsgBridge(): {
    getLastMsg?: () => Promise<LastWechatMsg | null>
    setLastMsg?: (data: Partial<LastWechatMsg>) => Promise<void>
  } | null {
    return ((globalThis as Record<string, unknown>).__PI_HUB__ ?? null) as ReturnType<typeof getHubLastMsgBridge>
  }

  /** 持久化最后一条微信用户消息（接管通知用，跨实例共享） */
  function persistLastWechatMessage(userId: string, text: string): void {
    const hub = getHubLastMsgBridge()
    if (hub?.setLastMsg) {
      void hub.setLastMsg({ userId, userMsg: text.slice(0, 200) })
      return
    }
    // 无 hub（降级）：本地写
    try {
      const file = path.join(os.homedir(), '.pi', 'agent', 'wechat-assistant', 'last-wechat-msg.json')
      const prev = readLocalLastWechatMsg()
      fs.writeFileSync(file, JSON.stringify({ userId, userMsg: text.slice(0, 200), aiMsg: prev?.aiMsg ?? '', ts: Date.now() }), { mode: 0o600 })
    } catch {
      // ignore
    }
  }

  /** 持久化最后一条 AI 回复（接管通知带完整对话上下文） */
  function persistLastWechatAiReply(userId: string, text: string): void {
    const hub = getHubLastMsgBridge()
    if (hub?.setLastMsg) {
      void hub.setLastMsg({ userId, aiMsg: text.slice(0, 500) })
      return
    }
    try {
      const file = path.join(os.homedir(), '.pi', 'agent', 'wechat-assistant', 'last-wechat-msg.json')
      const prev = readLocalLastWechatMsg()
      fs.writeFileSync(file, JSON.stringify({ userId, userMsg: prev?.userMsg ?? '', aiMsg: text.slice(0, 500), ts: Date.now() }), { mode: 0o600 })
    } catch {
      // ignore
    }
  }

  function readLocalLastWechatMsg(): LastWechatMsg | null {
    try {
      const file = path.join(os.homedir(), '.pi', 'agent', 'wechat-assistant', 'last-wechat-msg.json')
      return JSON.parse(fs.readFileSync(file, 'utf8')) as LastWechatMsg
    } catch {
      return null
    }
  }

  /** 取最后一条微信消息（从持久化文件，跨实例共享；接管时带上给用户上下文） */
  /** 取最后一条完整对话（用户消息 + AI 回复，跨实例共享；接管时带上下文） */
  async function getLastWechatMessage(): Promise<string | null> {
    try {
      const hub = getHubLastMsgBridge()
      const data = hub?.getLastMsg
        ? await hub.getLastMsg()
        : readLocalLastWechatMsg()
      if (!data || (!data.userMsg && !data.aiMsg)) return null
      // 1 小时内才展示（太久远无意义）
      if (Date.now() - data.ts > 3600_000) return null
      const parts: string[] = []
      if (data.userMsg) parts.push(`我：${data.userMsg}`)
      if (data.aiMsg) parts.push(`AI：${data.aiMsg}`)
      return parts.join('\n').slice(0, 600)
    } catch {
      return null
    }
  }

  const commandDeps: CommandDeps = {
    pi,
    getClient: () => client,
    setClient: (c) => { client = c },
    loadClient,
    isRunning: () => running,
    setRunning: (v) => { running = v; if (v) agentIdle = true },
    getPollAbort: () => pollAbort,
    setPollAbort: (c) => { pollAbort = c },
    queue,
    lock,
    unlock,
    stopBridge,
    pollMessages: startPolling,
    latestCtx: () => latestCtx,
    setLatestCtx: (ctx) => { latestCtx = ctx },
    updateStatusBar,
    notify,
    disposeClient,
  }

  registerCommands(pi, commandDeps)

  // --- 内部命令：微信 /new 开启新会话 ---
  // newSession 仅在扩展命令上下文（ExtensionCommandContext）可用，
  // 微信远程命令通过 sendUserMessage(expandPromptTemplates) 触发这里。

  pi.registerCommand('__wechat_new_session', {
    description: '通过微信开启新会话（内部命令，由微信远程命令 /new 触发）',
    handler: async (_args, ctx) => {
      const parentSession = ctx.sessionManager.getSessionFile() ?? undefined
      const result = await ctx.newSession({ parentSession })
      if (result.cancelled) {
        const g = globalThis as Record<string, unknown>
        const pending = g.__PI_WECHAT_NEW_SESSION_CONFIRM__ as { userId?: string } | undefined
        if (pending?.userId) {
          delete g.__PI_WECHAT_NEW_SESSION_CONFIRM__
          void client?.sendText(pending.userId, '❌ 开启新会话已被取消').catch(() => {})
        }
      }
    },
  })

  // --- 内部命令：微信 /reload 重载扩展 ---

  pi.registerCommand('__wechat_reload', {
    description: '通过微信重载扩展（内部命令，由微信远程命令 /reload 触发）',
    handler: async (_args, ctx) => {
      await ctx.reload()
    },
  })

  // --- 内部命令：微信 /prev /next /goto 切换会话 ---

  const formatSessionTime = (d: Date) => {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }

  pi.registerCommand('__wechat_switch_session', {
    description: '通过微信切换会话（内部命令，prev/next/goto 由微信远程命令触发）',
    handler: async (args, ctx) => {
      const [modeArg, ...restArgs] = (args || 'prev').trim().split(/\s+/)
      const mode = modeArg as 'prev' | 'next' | 'goto'
      const g = globalThis as Record<string, unknown>
      const pending = g.__PI_WECHAT_SWITCH_CONFIRM__ as { userId?: string; message?: string } | undefined
      const notify = (msg: string) => {
        if (pending?.userId) {
          delete g.__PI_WECHAT_SWITCH_CONFIRM__
          void client?.sendText(pending.userId, msg).catch(() => {})
        }
      }
      try {
        const current = ctx.sessionManager.getSessionFile()
        if (!current) {
          notify('❌ 未找到当前会话')
          return
        }
        const all = (await SessionManager.list(ctx.cwd)).sort((a, b) => b.modified.getTime() - a.modified.getTime())
        let target: { path: string; name?: string; modified: Date }
        let dir: string
        if (mode === 'goto') {
          const n = parseInt(restArgs[0] ?? '', 10)
          if (!Number.isFinite(n) || n < 1 || n > all.length) {
            notify(Number.isFinite(n) && n >= 1 ? `❌ 只有 ${all.length} 个会话` : '❌ 无效的序号')
            return
          }
          if (all[n - 1].path === current) {
            notify(`✅ 已经在第 ${n} 个会话了`)
            return
          }
          target = all[n - 1]
          dir = `第 ${n} 个`
        } else {
          const idx = all.findIndex((s) => s.path === current)
          if (idx === -1) {
            notify('❌ 未找到当前会话')
            return
          }
          const targetIdx = mode === 'prev' ? idx + 1 : idx - 1
          if (targetIdx < 0 || targetIdx >= all.length) {
            notify(mode === 'prev' ? '❌ 已经没有更早的会话了' : '❌ 已经在最新的会话了')
            return
          }
          target = all[targetIdx]
          dir = mode === 'prev' ? '上一次' : '下一次'
        }
        if (pending) {
          const label = target.name ?? formatSessionTime(target.modified)
          pending.message = `✅ 已切到${dir}的会话（${label}）`
        }
        const result = await ctx.switchSession(target.path, { withSession: async () => {} })
        if (result.cancelled) notify('❌ 切换会话已被取消')
      } catch (err) {
        notify(`❌ 切换会话失败: ${formatError(err)}`)
      }
    },
  })

  // ============================================================================
  // AI 工具注册
  // ============================================================================

  pi.registerTool({
    name: 'send_file_to_wechat',
    label: 'Send File to WeChat',
    description: '发送项目目录中的文件到当前微信对话。用于将 AI 产出的代码、报告等文件直接发给微信用户。',
    promptSnippet: '发送项目目录中的文件到微信',
    promptGuidelines: [
      '当用户通过微信要求产出文件时，先写入文件再用 send_file_to_wechat 发送。',
      '只能发送项目工作目录内的文件（安全限制）。',
      '如果发送失败，工具会返回错误信息。不要重试超过 1 次。',
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: '要发送的文件路径（项目目录内的绝对路径或相对路径）' }),
      fileName: Type.Optional(Type.String({ description: '在微信中显示的文件名（可选，默认使用原文件名）' })),
    }),
    async execute(_toolCallId, params, _signal) {
      const guard = guardSendToWechat(client, running, queue.lastWechatUser, params.filePath, latestCtx)
      if (!guard.allowed) return guard.error
      const sizeError = guardFileSize(guard.resolvedPath)
      if (sizeError) return sizeError

      try {
        const stats = statSync(guard.resolvedPath)
        await client!.sendFile(queue.lastWechatUser!.userId, guard.resolvedPath, params.fileName)
        const name = params.fileName ?? path.basename(guard.resolvedPath)
        return ok(`✅ 文件「${name}」(${(stats.size / 1024).toFixed(1)} KB) 已发送到微信`)
      } catch (err) {
        log(`send_file_to_wechat 失败: ${formatError(err)}`)
        return fail(`发送失败: ${formatError(err)}`)
      }
    },
  })

  pi.registerTool({
    name: 'send_image_to_wechat',
    label: 'Send Image to WeChat',
    description: '发送项目目录中的图片到当前微信对话。用于将 AI 生成的图表、截图等直接发给微信用户。',
    promptSnippet: '发送项目目录中的图片到微信（可预览）',
    promptGuidelines: [
      '当用户通过微信要求生成图表/截图/图片时，先生成图片文件再用 send_image_to_wechat 发送。',
      '只能发送项目工作目录内的图片（安全限制）。',
      '如果发送失败不要重试超过 1 次。',
    ],
    parameters: Type.Object({
      imagePath: Type.String({ description: '要发送的图片路径（项目目录内的绝对路径或相对路径，支持 png/jpg/gif/webp）' }),
    }),
    async execute(_toolCallId, params, _signal) {
      const guard = guardSendToWechat(client, running, queue.lastWechatUser, params.imagePath, latestCtx)
      if (!guard.allowed) return guard.error
      const sizeError = guardFileSize(guard.resolvedPath)
      if (sizeError) return sizeError

      try {
        const stats = statSync(guard.resolvedPath)
        await client!.sendImage(queue.lastWechatUser!.userId, guard.resolvedPath)
        return ok(`✅ 图片 (${(stats.size / 1024).toFixed(1)} KB) 已发送到微信`)
      } catch (err) {
        log(`send_image_to_wechat 失败: ${formatError(err)}`)
        return fail(`发送失败: ${formatError(err)}`)
      }
    },
  })

  // ============================================================================
  // 微信问卷桥接 API（供 ask-user-question-rpc 等扩展在微信 turn 中委托提问）
  // ============================================================================

  const wechatQuestionBridge: WechatQuestionBridge = {
    isWechatTurnActive: () => running && !!client && turn.wechatConversationActive,
    getActiveUserId: () => turn.targetUser,
    askQuestion: async (opts) => {
      if (!running || !client) return null
      const userId = opts.userId ?? turn.targetUser ?? queue.lastWechatUser?.userId
      if (!userId) return null
      const answer = await queue.askQuestion({ ...opts, userId })
      if (!answer) return null
      switch (answer.kind) {
        case 'option':
          return { kind: 'option', answer: answer.label }
        case 'multi':
          return { kind: 'multi', answer: null, selected: answer.labels }
        case 'custom':
          return { kind: 'custom', answer: answer.text }
        default:
          return { kind: 'chat', answer: null }
      }
    },
  }
  ;(globalThis as unknown as { __PI_WECHAT_BRIDGE__?: WechatQuestionBridge }).__PI_WECHAT_BRIDGE__ = wechatQuestionBridge

  // ============================================================================
  // 事件处理
  // ============================================================================

  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx
    // 实例名与协调中心保持一致（hub 可能用 config.instanceName 覆盖 cwd 名）
    currentInstanceName = getHubBridge()?.getInstanceName?.() || path.basename(process.env.PWD || ctx.cwd) || 'local'
    wechatFilesDir = path.join(ctx.cwd, WECHAT_FILES_SUBDIR)
    await loadClient()
    updateStatusBar()

    // 注册到 pi-hub（协调核心）：渠道只负责协议收发，接管/锁/消息路由由 hub 仲裁
    const hub = (globalThis as Record<string, unknown>).__PI_HUB__ as
      | { registerGateway?: (gw: unknown) => void; onTakeoverRequest?: (cb: (req: { targetName?: string; capability?: string }) => void) => void }
      | undefined
    if (hub?.registerGateway) {
      hub.registerGateway(gateway)
    }
    // 接管让位 + 自动接管：
    //  - target 是其他实例 → 本机让位（停止轮询）
    //  - target 是本机 / local / 空 → 自动接管信号（锁空闲或协调中心不可达），尝试启动轮询
    hub?.onTakeoverRequest?.((req) => {
      const cap = req.capability ?? 'wechat'
      if (cap !== 'wechat') return
      const target = req.targetName
      if (target && target !== currentInstanceName && target !== 'local') {
        if (running) {
          log(`收到接管请求 (${target})，微信轮询让位`)
          void stopBridge({ releaseLock: false })
        }
        return
      }
      // 自动接管信号：本机应尝试获取锁并启动轮询
      if (running) return
      void (async () => {
        const lockResult = await lock()
        if (!lockResult.success) {
          log(`自动接管尝试失败: ${lockResult.message}`)
          return
        }
        running = true
        agentIdle = true
        pollAbort = new AbortController()
        notify(`微信桥接已接管 📱`, 'info')
        updateStatusBar()
        void gateway.connect().catch((err) => log(`gateway.connect 异常退出: ${formatError(err)}`))
        // 接管成功后通知微信用户
        void notifyWechatTakeover()
      })()
    })

    const config = await loadConfig()
    if (config.autoStart && client) {
      const lockResult = await lock()
      if (lockResult.success) {
        running = true
        agentIdle = true
        pollAbort = new AbortController()
        notify('微信桥接已自动启动 📱', 'info')
        updateStatusBar()
        void gateway.connect().catch(err => {
          log(`gateway.connect 异常退出: ${formatError(err)}`)
        })
        // 首次启动不通知微信用户（非接管切换）
      } else {
        log(`自动启动失败: ${lockResult.message}`)
      }
    }
  })

  // 用户在 TUI 主动输入非命令内容 → 打断微信对话活跃状态
  pi.on('input', (event, ctx) => {
    latestCtx = ctx
    if (event.source === 'extension') return
    const text = event.text?.trim()
    if (!text || text.startsWith('/')) return
    turn.wechatConversationActive = false
  })

  // 系统提示词注入
  pi.on('before_agent_start', async (event, ctx) => {
    latestCtx = ctx
    const request = queue.pendingInjection ?? queue.activeRequest
    log(`[BEFORE-AGENT] turnSeq=${turn.seq} pendingInjection=${!!queue.pendingInjection} activeRequest=${!!queue.activeRequest} willInject=${!!request}`)
    if (!request) return
    const injectedPrompt = buildSystemPrompt(event.systemPrompt)
    log(`[BEFORE-AGENT-INJECT] injecting wechat system prompt`)
    return { systemPrompt: injectedPrompt }
  })

  // agent 开始 → 记录 turn 元数据
  pi.on('agent_start', async (_event, ctx) => {
    turn.seq++
    latestCtx = ctx
    agentIdle = false
    turn.sentCount = 0
    turn.messages = null
    turn.ended = false

    if (queue.pendingInjection) {
      queue.activeRequest = queue.pendingInjection
      turn.wechatConversationActive = true
      turn.targetUser = queue.activeRequest.userId
      log(`[AGENT-START] turn#${turn.seq} source=WECHAT userId=${turn.targetUser} pendingInjection consumed`)
      queue.pendingInjection = null
    } else {
      turn.targetUser = queue.lastWechatUser?.userId ?? null
      log(`[AGENT-START] turn#${turn.seq} source=TUI targetUser=${turn.targetUser ?? 'null'}`)
    }
  })

  // 增量发送（仅微信触发的 turn）
  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant') return
    if (!running || !client || !turn.wechatConversationActive) return

    const targetUserId = turn.targetUser
    if (!targetUserId) {
      log(`[MSG-END-SKIP] no target user`)
      return
    }

    const text = extractTextFromMessageContent(event.message.content)
    if (!text) {
      log(`[MSG-END-SKIP] no text content (likely toolCall only)`)
      return
    }

    log(`[MSG-END] incremental send to ${targetUserId}, textLen=${text.length} preview=${text.slice(0, 60)} sentCount=${turn.sentCount}`)

    try {
      const chunks = splitAndFilterMarkdown(text)
      for (let i = 0; i < chunks.length; i++) {
        log(`[MSG-END-CHUNK] ${i + 1}/${chunks.length} len=${chunks[i].length}`)
        await client.sendText(targetUserId, chunks[i])
      }
      turn.sentCount++
      // 记录最后一条 AI 回复（接管通知带完整上下文）
      persistLastWechatAiReply(targetUserId, text)
      log(`[MSG-END-DONE] incrementally sent, totalSent=${turn.sentCount}`)
    } catch (err) {
      log(`[MSG-END-ERROR] ${formatError(err)}`)
    }
  })

  // agent 结束 → 补发遗漏 + 收尾
  pi.on('agent_end', async (event, ctx) => {
    latestCtx = ctx
    agentIdle = true
    turn.ended = true
    turn.messages = event.messages as Array<{ role?: string; content?: unknown }>

    const msgCount = turn.messages.length
    const assistantMsgs = turn.messages.filter(m => m?.role === 'assistant').length
    log(`[AGENT-END] turn#${turn.seq} source=${turn.wechatConversationActive ? 'WECHAT' : 'TUI'} targetUser=${turn.targetUser} messages=${msgCount} assistant=${assistantMsgs} sentCount=${turn.sentCount}`)

    const allReplies = extractAllAssistantReplies(turn.messages)
    const newReplies = allReplies.slice(turn.sentCount)
    log(`[AGENT-END-REPLIES] all=${allReplies.length} sent=${turn.sentCount} new=${newReplies.length}`)

    if (turn.wechatConversationActive && newReplies.length > 0 && client && turn.targetUser) {
      try {
        await queue.sendRepliesToWechat(newReplies, turn.targetUser)
        // 记录最后一条 AI 回复（接管通知带完整上下文）
        persistLastWechatAiReply(turn.targetUser, newReplies[newReplies.length - 1])
        log(`[AGENT-END-DONE] sent ${newReplies.length} remaining replies`)
      } catch (err) {
        log(`[AGENT-END-ERROR] ${formatError(err)}`)
        notify(`发送微信回复失败: ${formatError(err)}`, 'error')
      }
    } else if (allReplies.length === 0) {
      log(`[AGENT-END-NOREPLY] no assistant text`)
    } else {
      log(`[AGENT-END-SAFE] all replies already sent incrementally`)
    }

    if (queue.activeRequest) {
      await client?.stopTyping(queue.activeRequest.userId).catch(() => {})
      queue.activeRequest = null
    }

    // 兜底：agent 结束时仍有未完成的问题（异常中断路径）→ 取消等待
    if (queue.pendingQuestion) {
      log(`[AGENT-END] cancelling leftover pending question`)
      queue.cancelPendingQuestion()
    }
    updateStatusBar()

    log(`[AGENT-END-DEFER] deferring drainQueue`)
    setImmediate(() => void queue.drain())
  })

  // 会话关闭 → 清理 + 落盘 context tokens
  pi.on('session_shutdown', async (_event, ctx) => {
    latestCtx = ctx
    clearInterval(heartbeatTimer)
    // reload/new 等会话替换场景：不释放全局锁（避免重载窗口内他机抢锁切换持有者），
    // 重载后同 pid 续约继续持有；仅真正退出（quit）时释放，让 TTL 自然让位
    const reason = (_event as { reason?: string } | undefined)?.reason
    const isQuit = reason === 'quit' || reason === undefined
    await stopBridge({ releaseLock: isQuit })
    await disposeClient()
  })

  // --- 进程退出清理 ---

  const exitHandler = () => {
    if (client) {
      // 同步 fire-and-forget（进程退出时无法 await），至少清除锁
      client.dispose().catch(() => {})
    }
    if (lockSessionId) {
      releaseLock(lockSessionId).catch(() => {})
    }
  }

  process.once('SIGINT', exitHandler)
  process.once('SIGTERM', exitHandler)
  process.once('beforeExit', exitHandler)
}
