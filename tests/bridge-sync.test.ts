import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeConfig } from '../src/auth.js'

const state = vi.hoisted(() => ({
  config: {} as BridgeConfig,
  queue: null as any,
  client: {
    userId: 'bound-user', accountId: 'bot', lastActiveUserId: null,
    hasContextToken: false,
    lastSend: null as { success: boolean; at: string; error?: string } | null,
    onStatusChange: undefined as (() => void) | undefined,
    sendText: vi.fn(), notifyStart: vi.fn(), notifyStop: vi.fn(),
    getUpdates: vi.fn(), dispose: vi.fn(), startTyping: vi.fn(), stopTyping: vi.fn(),
  },
}))
vi.mock('../src/client.js', () => ({
  WeixinClient: { create: vi.fn(async () => state.client) },
  SessionExpiredError: class extends Error {},
}))
vi.mock('../src/auth.js', async () => ({
  ...await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js'),
  getStateDir: () => process.cwd() + '/node_modules/.cache/wechat-bridge-test-state',
  loadCredentials: vi.fn(async () => ({})),
  loadConfig: vi.fn(async () => state.config),
  saveConfig: vi.fn(async (config: BridgeConfig) => { state.config = config }),
  getConfigCache: vi.fn(() => state.config),
  acquireLock: vi.fn(async () => ({ success: true })),
  releaseLock: vi.fn(),
}))
vi.mock('../src/queue.js', async () => {
  const actual = await vi.importActual<typeof import('../src/queue.js')>('../src/queue.js')
  return { ...actual, MessageQueue: class extends actual.MessageQueue {
    constructor(...args: ConstructorParameters<typeof actual.MessageQueue>) { super(...args); state.queue = this }
  } }
})
import extension from '../src/index.js'
import { extractTextFromMessageContent } from '../src/utils.js'
import { WECHAT_STATUS_ICON } from '../src/status.js'

describe('bridge bidirectional sync and lifecycle', () => {
  let handlers: Record<string, (event: any, ctx: any) => any>
  let commands: Record<string, any>
  let activeTools: string[]
  let registeredTools: Map<string, any>
  let sendUserMessage: ReturnType<typeof vi.fn>
  let ctx: any
  let oldListeners: Map<string, Function[]>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubEnv('NO_COLOR', '1')
    vi.stubEnv('PI_WECHAT_STATUS_ICON', undefined)
    state.config = {}
    state.client.hasContextToken = false
    state.client.lastSend = null
    state.client.onStatusChange = undefined
    state.client.sendText.mockResolvedValue(undefined)
    // No real network, credentials, locks, or user messages.
    state.client.getUpdates.mockImplementation(() => new Promise(() => {}))
    for (const name of ['notifyStart', 'notifyStop', 'startTyping', 'stopTyping', 'dispose'] as const) {
      state.client[name].mockResolvedValue(undefined)
    }
    handlers = {}; commands = {}; activeTools = ['read', 'bash']; registeredTools = new Map()
    sendUserMessage = vi.fn()
    ctx = {
      cwd: process.cwd(), hasUI: true, isIdle: vi.fn(() => true), waitForIdle: vi.fn(),
      model: { provider: 'test', id: 'test-model' },
      modelRegistry: { hasConfiguredAuth: vi.fn(() => true), getApiKeyAndHeaders: vi.fn() },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    }
    oldListeners = new Map(['SIGINT', 'SIGTERM', 'beforeExit'].map(name => [name, process.listeners(name)]))
    extension({
      on: (name: string, handler: any) => { handlers[name] = handler },
      registerCommand: (name: string, command: any) => { commands[name] = command },
      registerTool: (tool: any) => { registeredTools.set(tool.name, tool); activeTools.push(tool.name) },
      getActiveTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = [...names] },
      sendUserMessage,
    } as any)
    await handlers.session_start({}, ctx)
  })
  afterEach(async () => {
    await handlers.session_shutdown({}, ctx)
    for (const [name, previous] of oldListeners) {
      for (const listener of process.listeners(name)) {
        if (!previous.includes(listener)) process.removeListener(name, listener as any)
      }
    }
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const command = (args: string) => commands.wechat.handler(args, ctx)
  async function startRun(text: string, source = 'interactive') {
    await handlers.input({ source, text }, ctx)
    await handlers.before_agent_start({ systemPrompt: 'base system prompt', prompt: text }, ctx)
    await handlers.agent_start({}, ctx)
    ctx.isIdle.mockReturnValue(false)
    await handlers.message_start({ message: { role: 'user', content: text } }, ctx)
  }
  async function wechatInput(text: string, newRun = false) {
    const calls = sendUserMessage.mock.calls.length
    state.queue.enqueue({
      messageId: String(calls), userId: 'bound-user', text, type: 'text', imageUrls: [],
      raw: { from_user_id: 'bound-user' }, contextToken: '', timestamp: new Date(),
    })
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(calls + 1))
    const content = sendUserMessage.mock.calls[calls][0]
    const sentText = extractTextFromMessageContent(content)!
    await handlers.input({ source: 'extension', text: sentText }, ctx)
    if (newRun) {
      await handlers.before_agent_start({ systemPrompt: 'base system prompt', prompt: sentText }, ctx)
      await handlers.agent_start({}, ctx)
      ctx.isIdle.mockReturnValue(false)
    }
    await handlers.message_start({ message: { role: 'user', content } }, ctx)
    return content
  }
  const reply = (text: string) => handlers.message_end({ message: { role: 'assistant', content: text } }, ctx)

  const outgoing = () => state.client.sendText.mock.calls.filter(([, text]) => !text.startsWith('✅ 已收到'))
  const failure = (errorMessage = 'quota exceeded', content: unknown = []) => handlers.message_end({
    message: { role: 'assistant', stopReason: 'error', errorMessage, content },
  }, ctx)
  const settle = async (outcome = 'error', aborted = false) => {
    await handlers.agent_before_settle({ outcome }, ctx)
    await handlers.agent_settled({ aborted }, ctx)
  }
  const modern = () => { ctx.isProjectTrusted = () => ({}) }

  it('notifies modern hosts only at final settlement, even after progress, and never replays history', async () => {
    modern()
    await command('start')
    await wechatInput('work', true)
    await reply('working')
    state.client.sendText.mockClear()
    await failure('quota exceeded', 'partial response that a retry might repeat')
    await handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'old error' }] }, ctx)
    expect(outgoing()).toEqual([])
    await settle()
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('quota exceeded')]])
    expect(outgoing()[0][1]).toContain('自动处理已结束')
    await settle()
    expect(outgoing()).toHaveLength(1)
  })

  it('keeps WeChat routing and question guards across retries, and suppresses recovered errors', async () => {
    modern()
    state.config.bidirectionalSync = false
    await command('start')
    await wechatInput('work', true)
    await failure()
    await handlers.agent_end({ messages: [] }, ctx)
    await handlers.agent_start({}, ctx)
    expect(handlers.tool_call({ toolName: 'question' }, ctx)?.block).toBe(true)
    await reply('recovered')
    await settle('completed')
    expect(outgoing()).toEqual([['bound-user', 'recovered']])
  })

  it('reports only the last failed attempt after modern retry exhaustion', async () => {
    modern()
    await command('start')
    await wechatInput('work', true)
    await failure('temporary failure')
    await handlers.agent_end({ messages: [] }, ctx)
    await handlers.agent_start({}, ctx)
    await failure('final failure')
    await settle()
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('final failure')]])
  })

  it.each(['aborted-message', 'aborted-settlement', 'retry-cancel-before-boundary', 'aborted-signal'])('does not report user cancellation: %s', async mode => {
    modern()
    await command('start')
    await wechatInput('work', true)
    if (mode === 'retry-cancel-before-boundary') {
      // 0.99.2 skipped the boundary after a cancel during retry backoff; an
      // earlier normal settlement already latched this host as boundary-capable.
      await reply('warmup')
      await settle('completed')
      state.client.sendText.mockClear()
      await failure()
      await handlers.agent_settled({}, ctx) // 0.99.2 has no aborted field
      expect(outgoing()).toEqual([])
      return
    }
    const abort = new AbortController()
    ctx.signal = abort.signal
    await failure()
    if (mode === 'aborted-message') await handlers.message_end({ message: { role: 'assistant', stopReason: 'aborted', content: [] } }, ctx)
    if (mode === 'aborted-signal') abort.abort()
    else await settle(mode === 'aborted-message' ? 'aborted' : 'error', mode === 'aborted-settlement')
    expect(outgoing()).toEqual([])
  })

  it('notifies at settlement on hosts that never emit the boundary event (Pi 0.84.x)', async () => {
    modern() // isProjectTrusted present, so the probe selects the settled path…
    await command('start')
    await wechatInput('work', true)
    await failure('401 invalid api key')
    await handlers.agent_end({ messages: [] }, ctx)
    await handlers.agent_settled({}, ctx) // …but the host has no agent_before_settle
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('401 invalid api key')]])
    expect(outgoing()[0][1]).toContain('自动处理已结束')
  })

  it('does not infer model failure from keywords, tool errors, history, or silence', async () => {
    modern()
    await command('start')
    await wechatInput('work', true)
    await reply('error failed aborted: these are example words')
    state.client.sendText.mockClear()
    await handlers.message_end({ message: { role: 'toolResult', isError: true, content: 'failed' } }, ctx)
    await handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'historic failure' }] }, ctx)
    await settle('completed')
    expect(outgoing()).toEqual([])
  })

  it('sends one factual legacy attempt notice despite retries and repeated events', async () => {
    await command('start')
    await wechatInput('work', true)
    await failure()
    await handlers.agent_end({ messages: [] }, ctx)
    await handlers.agent_start({}, ctx)
    await failure()
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('Pi 可能自动重试')]])
    await reply('recovered')
    await wechatInput('second request')
    await failure()
    expect(outgoing()).toHaveLength(3)
  })

  it('does not retry an error notification after an ambiguous send rejection', async () => {
    await command('start')
    await wechatInput('work', true)
    state.client.sendText.mockRejectedValueOnce(new Error('connection lost'))
    await failure()
    await failure()
    expect(outgoing()).toHaveLength(1)
  })

  it.each([false, true])('respects TUI bidirectional sync=%s for failures and clears the old WeChat source', async enabled => {
    modern()
    state.config.bidirectionalSync = enabled
    await command('start')
    await wechatInput('wechat', true)
    await failure('wechat error')
    await startRun('new TUI request')
    state.client.sendText.mockClear()
    await failure('TUI error')
    await settle()
    expect(outgoing()).toHaveLength(enabled ? 1 : 0)
    if (enabled) expect(outgoing()[0][1]).toContain('TUI error')
  })

  it('drops pending notices when stopped', async () => {
    modern()
    await command('start')
    await wechatInput('work', true)
    await failure()
    await command('stop')
    await settle()
    expect(outgoing()).toEqual([])
  })

  it('reports actual WeChat failures with the source marker disabled', async () => {
    modern()
    state.config.messageSourceTag = { enabled: false }
    state.config.bidirectionalSync = false
    await command('start')
    await wechatInput('work', true)
    await failure()
    await settle()
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('quota exceeded')]])
  })

  it('does not clear a new request while the previous settlement notification is sending', async () => {
    modern()
    state.config.bidirectionalSync = false
    await command('start')
    await wechatInput('first', true)
    await failure()
    let resolve!: () => void
    state.client.sendText.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    await handlers.agent_before_settle({ outcome: 'error' }, ctx)
    const sending = handlers.agent_settled({}, ctx)
    await wechatInput('second')
    resolve()
    await sending
    await reply('second answer')
    expect(outgoing()).toHaveLength(2)
    expect(outgoing()[1]).toEqual(['bound-user', 'second answer'])
  })

  it('never rejects TUI or unrelated extension input during startup checks', async () => {
    await command('start')
    ctx.model = undefined
    for (const source of ['interactive', 'extension']) {
      expect(await handlers.input({ source, text: 'unrelated' }, ctx)).toBeUndefined()
    }
    expect(outgoing()).toEqual([])
  })

  it('does not reject busy follow-ups based on a transient model/auth snapshot', async () => {
    await command('start')
    ctx.isIdle.mockReturnValue(false)
    ctx.model = undefined
    await wechatInput('queued request')
    expect(outgoing()).toEqual([])
  })

  // Emulate Pi invoking input while sendUserMessage is delivering an idle request.
  async function deliverIdleInput() {
    let result: any
    sendUserMessage.mockImplementationOnce(async (content: unknown) => {
      result = await handlers.input({ source: 'extension', text: extractTextFromMessageContent(content) }, ctx)
    })
    state.queue.enqueue({ messageId: 'preflight', userId: 'bound-user', text: 'work', type: 'text', imageUrls: [],
      raw: { from_user_id: 'bound-user' }, contextToken: '', timestamp: new Date() })
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalled())
    return () => result
  }

  it.each(['no-model', 'legacy-auth', 'modern-auth'])('reports idle startup rejection without waiting for nonexistent lifecycle events: %s', async mode => {
    await command('start')
    if (mode === 'no-model') ctx.model = undefined
    else {
      ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false)
      if (mode === 'modern-auth') {
        modern()
        ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: false, error: 'auth unavailable' })
      }
    }
    const result = await deliverIdleInput()
    await vi.waitFor(() => expect(result()).toEqual({ action: 'handled' }))
    expect(outgoing()).toEqual([['bound-user', expect.stringContaining('无法开始模型请求')]])
    expect(state.queue.pendingInjection).toBeNull()
  })

  it('allows lazy modern authentication rather than treating the synchronous snapshot as failure', async () => {
    modern()
    await command('start')
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false)
    ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: 'test' })
    await deliverIdleInput()
    await vi.waitFor(() => expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalled())
    expect(outgoing()).toEqual([])
    expect(state.queue.pendingInjection).not.toBeNull()
  })

  it('does not deliver stale asynchronous auth errors after stopping and restarting', async () => {
    modern()
    await command('start')
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false)
    let resolve!: (value: unknown) => void
    ctx.modelRegistry.getApiKeyAndHeaders.mockReturnValue(new Promise(done => { resolve = done }))
    const result = await deliverIdleInput()
    await command('stop')
    await command('start')
    resolve({ ok: false, error: 'stale auth failure' })
    await vi.waitFor(() => expect(result()).toEqual({ action: 'handled' }))
    expect(outgoing()).toEqual([])
  })

  it.each([
    { systemPrompt: 'base', prompt: 'TUI request' },
    { systemPrompt: 'base', messageType: 'user', prompt: 'TUI request', systemPromptOptions: { sections: { identity: 'base' } } },
    { systemPrompt: 'base', messageType: 'custom', message: { role: 'custom' }, systemPromptOptions: { sections: {} } },
  ])('leaves legacy and modern system prompts untouched before the bridge starts', async event => {
    const original = structuredClone(event)
    expect(await handlers.before_agent_start(event, ctx)).toBeUndefined()
    expect(event).toEqual(original)
    expect(registeredTools.size).toBe(0)
    expect(activeTools).toEqual(['read', 'bash'])
  })

  it('registers tools only on start, disables them on stop, and reuses them on restart', async () => {
    expect(registeredTools.size).toBe(0)
    await command('start')
    expect(activeTools).toEqual(['read', 'bash', 'send_file_to_wechat', 'send_image_to_wechat'])
    expect(registeredTools.size).toBe(2)
    await command('stop')
    expect(activeTools).toEqual(['read', 'bash'])
    await command('start')
    expect(registeredTools.size).toBe(2)
    expect(activeTools).toHaveLength(4)
  })

  it('keeps the footer compact before and after acquiring context or sending successfully', async () => {
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⏸`)
    await command('start')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⇄ ▶`)
    state.client.hasContextToken = true
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⇄ ▶`)
    state.client.lastSend = { success: true, at: '2026-10-13T10:00:00Z' }
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⇄ ▶`)
    await command('stop')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⏸`)
  })

  it('refreshes the compact sync mode indicator immediately when toggled', async () => {
    await command('start')
    await command('config bidirectional off')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ▶`)
    await command('config bidirectional on')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⇄ ▶`)
  })

  it('shows a queue count only while messages are pending', async () => {
    await command('start')
    const pending = vi.spyOn(state.queue, 'pending', 'get').mockReturnValue(3)
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⇄ ▶ | 待处理:3`)
    pending.mockReturnValue(0)
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⇄ ▶`)
  })

  it('surfaces send failure without error details and clears it on the next successful send', async () => {
    await command('start')
    state.client.lastSend = { success: false, at: '2026-10-13T10:00:00Z', error: 'network timeout' }
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⇄ ▶ | 发送失败`)
    await command('status')
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('失败: network timeout'), 'info')
    state.client.lastSend = { success: true, at: '2026-10-13T10:01:00Z' }
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⇄ ▶`)
    await command('status')
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('API 返回成功（不代表已读）'), 'info')
  })

  it('combines pending count and send failure without extra mode text, hiding both while stopped', async () => {
    state.config.bidirectionalSync = false
    await command('start')
    vi.spyOn(state.queue, 'pending', 'get').mockReturnValue(2)
    state.client.lastSend = { success: false, at: '2026-10-13T10:00:00Z', error: 'rejected' }
    state.client.onStatusChange?.()
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ▶ | 待处理:2 | 发送失败`)
    await command('stop')
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('wechat', `${WECHAT_STATUS_ICON} ⏸`)
  })

  it('shows the default template while the bridge runs with source rules on by default', async () => {
    await command('start')
    expect(state.config.messageSourceTag?.enabled === false).toBe(false)
    await command('prompt show')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('直接用正文提问'), 'info')
  })

  it('never prints notifications to stdout while a UI is attached', async () => {
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.join(' '))
    })
    try {
      await command('start')
      await command('config source off')
    } finally {
      log.mockRestore()
    }
    expect(printed.join('')).toBe('')
    expect(ctx.ui.notify).toHaveBeenCalled()
  })

  it('waits for the active run before starting the bridge tools', async () => {
    ctx.isIdle.mockReturnValue(false)
    ctx.waitForIdle.mockImplementation(async () => { ctx.isIdle.mockReturnValue(true) })
    await command('start')
    expect(ctx.waitForIdle).toHaveBeenCalledOnce()
    expect(registeredTools.size).toBe(2)
  })

  it('sends TUI input and new assistant replies by default without first inbound activity', async () => {
    await command('start')
    await startRun('run tests')
    await reply('tests passed')
    expect(state.client.sendText.mock.calls).toEqual([
      ['bound-user', '[电脑端] run tests'], ['bound-user', 'tests passed'],
    ])
    expect(state.client.notifyStart).toHaveBeenCalledTimes(1)
  })

  it.each([
    { text: '比较这两张图', expected: '[电脑端] 比较这两张图\n[附带 2 张图片]' },
    { text: '', expected: '[电脑端] 发送了 2 张图片' },
    { text: '长'.repeat(1200), expected: '[电脑端] ' + '长'.repeat(1200) + '\n[附带 2 张图片]' },
  ])('mirrors consumed TUI images with text length $text.length', async ({ text, expected }) => {
    await command('start')
    await startRun('earlier task')
    state.client.sendText.mockClear()
    const images = [
      { type: 'image', mimeType: 'image/png', data: 'first-image' },
      { type: 'image', mimeType: 'image/jpeg', data: 'second-image' },
    ]
    const content = [{ type: 'text', text }, ...images]
    const original = structuredClone(content)
    await handlers.input({ source: 'interactive', text, images }, ctx)
    expect(state.client.sendText).not.toHaveBeenCalled()
    await handlers.message_start({ message: { role: 'user', content } }, ctx)
    expect(state.client.sendText.mock.calls.map(([, chunk]) => chunk).join('')).toBe(expected)
    expect(content).toEqual(original)
  })

  it.each(['disabled', 'stopped'])('does not mirror image-only messages when sync is %s', async mode => {
    await command('start')
    if (mode === 'disabled') await command('config bidirectional off')
    else await command('stop')
    const content = [{ type: 'image', mimeType: 'image/png', data: 'image' }]
    await handlers.message_start({ message: { role: 'user', content } }, ctx)
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('does not mirror images submitted by the WeChat bridge', async () => {
    await command('start')
    state.queue.queue.push({
      id: 'image', userId: 'bound-user', messageId: 'image', receivedAt: new Date(),
      text: '', preview: '[图片]', contextToken: '',
      imageData: { data: 'wechat-image', mediaType: 'image/png' },
    })
    await state.queue.drain()
    expect(sendUserMessage).toHaveBeenCalledOnce()
    const content = sendUserMessage.mock.calls[0][0]
    const text = extractTextFromMessageContent(content)!
    const images = content.filter((part: any) => part.type === 'image')
    expect(images).toHaveLength(1)
    await handlers.input({ source: 'extension', text, images }, ctx)
    state.client.sendText.mockClear()
    await handlers.message_start({ message: { role: 'user', content } }, ctx)
    expect(state.queue.activeRequest?.userId).toBe('bound-user')
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('can disable TUI sync without changing the message source selection', async () => {
    state.config.bidirectionalSync = false
    await command('start')
    await startRun('run tests')
    await reply('tests passed')
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('delivers a busy WeChat follow-up with TUI sync off, then switches back to TUI inside the same run', async () => {
    state.config.bidirectionalSync = false
    await command('start')
    await startRun('TUI task')
    await wechatInput('微信任务')
    await handlers.input({ source: 'interactive', text: 'queued TUI input' }, ctx)
    state.client.sendText.mockClear() // Exclude the inbound acknowledgement.
    await reply('wechat reply')
    expect(state.client.sendText.mock.calls).toEqual([['bound-user', 'wechat reply']])
    await handlers.message_start({ message: { role: 'user', content: 'queued TUI input' } }, ctx)
    await reply('TUI reply')
    expect(state.client.sendText).toHaveBeenCalledTimes(1)
  })

  it('appends the same fixed conditional system rules for WeChat and TUI turns while running', async () => {
    await command('start')
    await command('config source on')
    const tools = [...activeTools]
    const content = await wechatInput('微信任务', true)
    expect(content).toMatch(/^\[微信\]/)
    expect(content).not.toContain('直接用正文提问')
    const event = { systemPrompt: 'base system prompt', systemPromptOptions: { sections: { identity: 'base' } }, messageType: 'user', prompt: 'next TUI task' }
    const result = await handlers.before_agent_start(event, ctx)
    expect(result?.systemPrompt).toMatch(/^base system prompt\n\n<wechat-system-rules>/)
    expect(result?.systemPrompt).toContain('直接用正文提问')
    expect(result?.systemPrompt).toContain(JSON.stringify('[微信]'))
    expect(result?.systemPrompt).toContain('仅在当前最新用户请求由微信桥接投递')
    const wechatEvent = { systemPrompt: 'base system prompt', prompt: String(content) }
    expect((await handlers.before_agent_start(wechatEvent, ctx))?.systemPrompt).toBe(result?.systemPrompt)
    expect(activeTools).toEqual(tools)
    await command('config source off')
    const off = { systemPrompt: 'unchanged' }
    const original = structuredClone(off)
    expect(await handlers.before_agent_start(off, ctx)).toBeUndefined()
    expect(off).toEqual(original)
    await handlers.agent_start({}, ctx)
    expect(await wechatInput('普通输入')).toBe('普通输入')
    expect(activeTools).toEqual(tools)
  })

  it('does not mistake a TUI marker for an inbound request', async () => {
    state.config.bidirectionalSync = false
    state.config.messageSourceTag = { enabled: false }
    await command('start')
    await command('config source on')
    await startRun('[微信]\n\nTUI request')
    await reply('local reply')
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('blocks known local question tools by default for a confirmed WeChat request only', async () => {
    await command('start')
    await wechatInput('微信请求', true)
    for (const toolName of ['question', 'questionnaire']) {
      const result = await handlers.tool_call({ toolName, parentToolCallId: 'codemode/1' }, ctx)
      expect(result).toMatchObject({ block: true, reason: expect.stringContaining('回复正文中提问') })
    }
    expect(await handlers.tool_call({ toolName: 'read' }, ctx)).toBeUndefined()
    await handlers.input({ source: 'interactive', text: 'TUI request' }, ctx)
    await handlers.message_start({ message: { role: 'user', content: 'TUI request' } }, ctx)
    expect(await handlers.tool_call({ toolName: 'question' }, ctx)).toBeUndefined()
    await command('config source off')
    await wechatInput('关掉后的微信请求')
    expect(await handlers.tool_call({ toolName: 'question' }, ctx)).toBeUndefined()
  })

  it('allows the user to configure the exact question tools guarded for WeChat', async () => {
    state.config.messageSourceTag = { enabled: true, blockedTools: ['ask_user'] }
    await command('start')
    await wechatInput('微信请求', true)
    expect(await handlers.tool_call({ toolName: 'question' }, ctx)).toBeUndefined()
    expect(await handlers.tool_call({ toolName: 'ask_user' }, ctx)).toMatchObject({ block: true })
    state.config.messageSourceTag.blockedTools = []
    expect(await handlers.tool_call({ toolName: 'ask_user' }, ctx)).toMatchObject({ block: true })
    await wechatInput('下一条请求')
    expect(await handlers.tool_call({ toolName: 'ask_user' }, ctx)).toBeUndefined()
  })

  it('stop notifies the backend and blocks later assistant delivery', async () => {
    await command('start')
    await command('stop')
    await reply('later reply')
    expect(state.client.notifyStop).toHaveBeenCalledTimes(1)
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('warns and keeps polling when a lifecycle state notification fails', async () => {
    state.client.notifyStart.mockRejectedValueOnce(new Error('start boom'))
    await command('start')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('start boom'), 'warning')
    await vi.waitFor(() => expect(state.client.getUpdates).toHaveBeenCalled())
    state.client.notifyStop.mockRejectedValueOnce(new Error('stop boom'))
    await command('stop')
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('stop boom'), 'warning')
    expect(ctx.ui.notify).toHaveBeenCalledWith('微信桥接已停止', 'info')
  })

  it('formats only the WeChat sending copy and preserves the assistant message', async () => {
    await command('start')
    await startRun('format reply')
    state.client.sendText.mockClear()
    const fence = String.fromCharCode(96).repeat(3)
    const message = { role: 'assistant', content: [{ type: 'text', text: '**结论** [文档](https://example.com/a_b)\n' + fence + 'js\n  const x = "**";\n' + fence }] }
    const original = structuredClone(message)
    expect(await handlers.message_end({ message }, ctx)).toBeUndefined()
    expect(message).toEqual(original)
    expect(state.client.sendText.mock.calls).toEqual([
      ['bound-user', '结论 文档: https://example.com/a_b'],
      ['bound-user', '代码 (js) (1/1)\n  const x = "**";\n'],
    ])
  })
})
