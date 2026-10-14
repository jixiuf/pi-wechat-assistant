// ============================================================================
// 测试: queue.ts — MessageQueue 入队/批处理/并发控制
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageQueue, getImageBatchWaitMs, getImageMaxBytes } from '../../src/bridge/queue.js'
import type { IncomingMessage } from '../../src/wechat/types.js'
import { getConfigCache } from '../../src/bridge/config.js'
import { fetchFile, fetchImageAsBase64, saveFileToDisk } from '../../src/wechat/media.js'
import { extractTextFromMessageContent } from '../../src/shared/utils.js'
import { WECHAT_SOURCE_TAG } from '../../src/messaging/wechat-source.js'
import { ACK_TEXT, IMAGE_BATCH_ACK_TEXT } from '../../src/shared/constants.js'

// --- Mock getConfigCache 使配置读取可控 ---
vi.mock('../../src/bridge/config.js', () => ({
  getConfigCache: vi.fn(() => ({})),
}))
vi.mock('../../src/wechat/media.js', () => ({
  fetchImageAsBase64: vi.fn(async () => null),
  fetchFile: vi.fn(async () => null),
  saveFileToDisk: vi.fn(async () => null),
}))

const queues = new Set<MessageQueue>()
beforeEach(() => {
  vi.clearAllMocks()
  // Marker and reply profile are on by default; opt these unit tests out to keep
  // asserting raw passthrough behaviour.
  vi.mocked(getConfigCache).mockReturnValue({ messageSourceTag: { enabled: false } })
  vi.mocked(fetchImageAsBase64).mockResolvedValue(null)
  vi.mocked(fetchFile).mockResolvedValue(null)
  vi.mocked(saveFileToDisk).mockResolvedValue(null)
})
afterEach(() => {
  for (const queue of queues) queue.reset()
  queues.clear()
  vi.useRealTimers()
})

// --- 工厂: 创建可测试的 MessageQueue ---
function makeQueue(opts?: {
  client?: ReturnType<typeof vi.fn>
  running?: boolean
  agentIdle?: boolean
  canSubmit?: () => boolean
}) {
  const client = opts?.client ?? vi.fn().mockReturnValue(null)
  const running = opts?.running ?? true
  const agentIdle = opts?.agentIdle ?? true
  const pollSignal = vi.fn(() => undefined)
  const wechatFilesDir = vi.fn(() => process.cwd())
  const sendUserMessage = vi.fn()
  const updateStatusBar = vi.fn()

  const queue = new MessageQueue(
    () => client() as any,
    () => running,
    () => agentIdle,
    () => pollSignal() as any,
    () => wechatFilesDir() as any,
    sendUserMessage,
    updateStatusBar,
    opts?.canSubmit,
  )

  return { queue, client, sendUserMessage, updateStatusBar }
}

// --- 辅助: 构造 IncomingMessage ---
function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg_1',
    userId: 'user_1',
    text: '',
    type: 'text',
    imageUrls: [],
    raw: {} as any,
    contextToken: 'token_1',
    timestamp: new Date(),
    ...overrides,
  }
}

describe('receipt notifications', () => {
  it.each([undefined, true, false])('honors sendAck=%s for text without blocking submission', async sendAck => {
    vi.mocked(getConfigCache).mockReturnValue({ sendAck, messageSourceTag: { enabled: false } })
    const sendText = vi.fn().mockResolvedValue(undefined)
    const { queue, sendUserMessage } = makeQueue({ client: vi.fn(() => ({ sendText, startTyping: vi.fn().mockResolvedValue(undefined) })) })
    queue.enqueue(makeMsg({ text: 'hello' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    if (sendAck === false) expect(sendText).not.toHaveBeenCalled()
    else expect(sendText).toHaveBeenCalledWith('user_1', ACK_TEXT)
  })

  it.each([undefined, true, false])('honors sendAck=%s for image batches without blocking submission', async sendAck => {
    vi.useFakeTimers()
    vi.mocked(getConfigCache).mockReturnValue({ sendAck, imageBatchWaitMs: 20 })
    vi.mocked(fetchImageAsBase64).mockResolvedValue({ data: 'image', mediaType: 'image/png' })
    const sendText = vi.fn().mockResolvedValue(undefined)
    const { queue, sendUserMessage } = makeQueue({ client: vi.fn(() => ({ sendText, startTyping: vi.fn().mockResolvedValue(undefined) })) })
    for (let i = 0; i < 2; i++) queue.enqueue(makeMsg({ imageUrls: [{ url: 'https://example.com/image.png' }] }))
    await vi.advanceTimersByTimeAsync(25)
    expect(sendUserMessage).toHaveBeenCalledOnce()
    if (sendAck === false) expect(sendText).not.toHaveBeenCalled()
    else {
      expect(sendText).toHaveBeenCalledOnce()
      expect(sendText).toHaveBeenCalledWith('user_1', IMAGE_BATCH_ACK_TEXT)
    }
  })

  it.each([['Custom receipt text', 'Custom image receipt'], ['  ', '  ']])('uses custom contents or default for blank values: %s', async (ackText, imageBatchAckText) => {
    vi.mocked(getConfigCache).mockReturnValue({ ackText, imageBatchAckText })
    const sendText = vi.fn().mockResolvedValue(undefined)
    const { queue, sendUserMessage } = makeQueue({ client: vi.fn(() => ({ sendText, startTyping: vi.fn().mockResolvedValue(undefined) })) })
    queue.enqueue(makeMsg({ text: 'hello' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    expect(sendText).toHaveBeenCalledWith('user_1', ackText.trim() || ACK_TEXT)
    queue.enqueue(makeMsg({ imageUrls: [{ url: 'https://example.com/image.png' }] }))
    expect(sendText).toHaveBeenCalledWith('user_1', imageBatchAckText.trim() || IMAGE_BATCH_ACK_TEXT)
  })

  it('keeps file-save confirmations and download errors when receipts are disabled', async () => {
    vi.mocked(getConfigCache).mockReturnValue({ sendAck: false })
    vi.mocked(fetchFile).mockResolvedValueOnce(Buffer.from('file')).mockResolvedValueOnce(null)
    vi.mocked(saveFileToDisk).mockResolvedValue('C:/project/report.txt')
    const sendText = vi.fn().mockResolvedValue(undefined)
    const { queue } = makeQueue({ client: vi.fn(() => ({ sendText })) })
    queue.enqueue(makeMsg({ fileEncryptParam: 'file', fileName: 'report.txt' }))
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith('user_1', expect.stringContaining('✅ 已保存:')))
    queue.enqueue(makeMsg({ fileEncryptParam: 'file', fileName: 'failed.txt' }))
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith('user_1', '⚠️ 文件下载失败: failed.txt'))
  })
})

describe('MessageQueue — enqueue', () => {
  it('enqueues text messages', () => {
    const { queue, sendUserMessage } = makeQueue({ agentIdle: false })
    const msg = makeMsg({ text: 'hello world' })
    queue.enqueue(msg)
    expect(queue.pending).toBe(1)
    // agent idle but running=true: should enqueue
    expect(queue.queue.length).toBe(1) // still in queue waiting for drain
  })

  it('enqueues image messages and sets batch timer', () => {
    vi.useFakeTimers()
    const mockSendText = vi.fn().mockResolvedValue(undefined)
    const { queue } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })
    const msg = makeMsg({
      text: '',
      type: 'image',
      imageUrls: [{ url: 'https://example.com/img.jpg' }],
    })
    queue.enqueue(msg)
    expect(queue.queue.length).toBeGreaterThanOrEqual(1)
    vi.useRealTimers()
  })

  it('sets lastWechatUser after enqueue', () => {
    const { queue } = makeQueue()
    const msg = makeMsg({ text: 'hello' })
    queue.enqueue(msg)
    expect(queue.lastWechatUser).toEqual({ userId: 'user_1', contextToken: 'token_1' })
  })
})

describe('MessageQueue — drain protection', () => {
  it('does not drain when not running', async () => {
    const { queue } = makeQueue({ running: false })
    const msg = makeMsg({ text: 'test' })
    queue.enqueue(msg)
    // drain is called but should skip
    await queue.drain()
    // Since we're not running, nothing should happen
    expect(queue.pendingInjection).toBeNull()
  })

  it('survives stale ctx throw from sendUserMessage (reload) and cleans up', async () => {
    const mockSendText = vi.fn().mockResolvedValue(undefined)
    const mockStopTyping = vi.fn().mockResolvedValue(undefined)
    const { queue, sendUserMessage } = makeQueue({
      client: vi.fn(() => ({
        startTyping: vi.fn().mockResolvedValue(undefined),
        stopTyping: mockStopTyping,
        sendText: mockSendText,
      })),
    })
    // 模拟 reload/newSession 后旧 ctx stale：pi.sendUserMessage 同步 throw
    sendUserMessage.mockImplementation(() => {
      throw new Error('This extension ctx is stale after session replacement or reload.')
    })

    queue.enqueue(makeMsg({ text: 'hello' }))

    // 投递失败后必须清理 pendingInjection，否则后续 drain 卡死
    await vi.waitFor(() => {
      expect(queue.pendingInjection).toBeNull()
    })
    expect(mockStopTyping).toHaveBeenCalled()
    // 投递失败则不再发回执
    expect(mockSendText).not.toHaveBeenCalled()
    // 后续 drain 不再抛出（无 unhandledRejection）
    await expect(queue.drain()).resolves.toBeUndefined()
  })
})

describe('MessageQueue — reset', () => {
  it('clears queue and accumulated state', () => {
    const { queue } = makeQueue()
    queue.enqueue(makeMsg({ text: 'test 1' }))
    queue.enqueue(makeMsg({ text: 'test 2' }))
    queue.lastWechatUser = { userId: 'u1', contextToken: 'ct1' }
    queue.pendingInjection = {} as any
    queue.activeRequest = {} as any

    queue.reset()

    expect(queue.pending).toBe(0)
    expect(queue.pendingInjection).toBeNull()
    expect(queue.activeRequest).toBeNull()
  })
})

describe('getImageBatchWaitMs', () => {
  it('returns default when no config', () => {
    expect(getImageBatchWaitMs()).toBe(8000)
  })

  it('respects env override', () => {
    process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS = '3000'
    expect(getImageBatchWaitMs()).toBe(3000)
    delete process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS
  })

  it('clamps to valid range (rejects invalid values, falls back to default)', () => {
    process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS = '-500'
    // -500 fails Number.isFinite && >0 check, falls back to DEFAULT=8000
    expect(getImageBatchWaitMs()).toBe(8000)
    process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS = '999999'
    // clamps to max 60000
    expect(getImageBatchWaitMs()).toBe(60000)
    delete process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS
  })
})

describe('getImageMaxBytes', () => {
  it('returns default 50MB', () => {
    expect(getImageMaxBytes()).toBe(50 * 1024 * 1024)
  })

  it('enforces minimum 1MB', () => {
    process.env.PI_WECHAT_IMAGE_MAX_BYTES = '100'
    expect(getImageMaxBytes()).toBe(1024 * 1024)
    delete process.env.PI_WECHAT_IMAGE_MAX_BYTES
  })
})

// ============================================================================
// upstream 移植用例（适配本地 steer/pendingInjection 模型）
// ============================================================================

import { getConfigCache } from '../../src/bridge/config.js'
import { WECHAT_SOURCE_TAG } from '../../src/messaging/wechat-source.js'

describe('微信来源标记（upstream wechat-source）', () => {
  it('为微信回合消息打上来源标记，条件规则据此生效', async () => {
    vi.mocked(getConfigCache).mockReturnValue({ messageSourceTag: { enabled: true } } as any)
    const mockSendText = vi.fn().mockResolvedValue(undefined)
    const { queue, sendUserMessage } = makeQueue({
      client: vi.fn(() => ({
        startTyping: vi.fn().mockResolvedValue(undefined),
        stopTyping: vi.fn().mockResolvedValue(undefined),
        sendText: mockSendText,
      })),
      agentIdle: true,
    })
    queue.enqueue(makeMsg({ text: '第一条' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    const [content] = sendUserMessage.mock.calls[0]
    const text = typeof content === 'string' ? content : (content as any[]).find(p => p.type === 'text')?.text
    expect(text.startsWith(WECHAT_SOURCE_TAG)).toBe(true)
    expect(text).toContain('第一条')
  })

  it('来源标识关闭时不打标记', async () => {
    vi.mocked(getConfigCache).mockReturnValue({ messageSourceTag: { enabled: false } } as any)
    const { queue, sendUserMessage } = makeQueue({
      client: vi.fn(() => ({
        startTyping: vi.fn().mockResolvedValue(undefined),
        stopTyping: vi.fn().mockResolvedValue(undefined),
        sendText: vi.fn().mockResolvedValue(undefined),
      })),
      agentIdle: true,
    })
    queue.enqueue(makeMsg({ text: '原文' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    const [content] = sendUserMessage.mock.calls[0]
    const text = typeof content === 'string' ? content : (content as any[]).find(p => p.type === 'text')?.text
    expect(text.startsWith(WECHAT_SOURCE_TAG)).toBe(false)
  })

  it('投递方式恒为 steer（避免 agent 忙时 followUp 报错）', async () => {
    vi.mocked(getConfigCache).mockReturnValue({ messageSourceTag: { enabled: false } } as any)
    const { queue, sendUserMessage } = makeQueue({
      client: vi.fn(() => ({
        startTyping: vi.fn().mockResolvedValue(undefined),
        stopTyping: vi.fn().mockResolvedValue(undefined),
        sendText: vi.fn().mockResolvedValue(undefined),
      })),
      agentIdle: true,
    })
    queue.enqueue(makeMsg({ text: 'hello' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    expect(sendUserMessage.mock.calls[0][1]).toEqual({ deliverAs: 'steer' })
  })
})

describe('canSubmit — agent preparing 期间暂缓投递（upstream 移植）', () => {
  it('holds the batch while Pi prepares and submits after preparation', async () => {
    vi.mocked(getConfigCache).mockReturnValue({ messageSourceTag: { enabled: false } } as any)
    let canSubmit = false
    const mockSendText = vi.fn().mockResolvedValue(undefined)
    const { queue, sendUserMessage } = makeQueue({
      client: vi.fn(() => ({
        startTyping: vi.fn().mockResolvedValue(undefined),
        stopTyping: vi.fn().mockResolvedValue(undefined),
        sendText: mockSendText,
      })),
      agentIdle: true,
      canSubmit: () => canSubmit,
    })

    queue.enqueue(makeMsg({ text: '准备中' }))
    await new Promise(r => setTimeout(r, 50))
    expect(sendUserMessage).not.toHaveBeenCalled()

    canSubmit = true
    await queue.drain()
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    expect(sendUserMessage.mock.calls[0][1]).toEqual({ deliverAs: 'steer' })
  })
})
