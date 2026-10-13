import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  config: {} as { bidirectionalSync?: boolean },
  queue: null as any,
  client: {
    userId: 'bound-user', accountId: 'bot', lastActiveUserId: null,
    hasContextToken: false, lastSend: null,
    sendText: vi.fn(), notifyStart: vi.fn(), notifyStop: vi.fn(),
    getUpdates: vi.fn(), dispose: vi.fn(), stopTyping: vi.fn(),
  },
}))
vi.mock('../src/client.js', () => ({
  WeixinClient: { create: vi.fn(async () => state.client) },
  SessionExpiredError: class extends Error {},
}))
vi.mock('../src/auth.js', async () => ({
  ...await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js'),
  loadCredentials: vi.fn(async () => ({})),
  loadConfig: vi.fn(async () => state.config),
  getConfigCache: vi.fn(() => state.config),
  acquireLock: vi.fn(async () => ({ success: true })),
  releaseLock: vi.fn(),
}))
vi.mock('../src/commands.js', () => ({
  registerCommands: (pi: any, deps: any) => pi.registerCommand('wechat', {
    handler: async (action: string, ctx: any) => {
      deps.setLatestCtx(ctx)
      if (action === 'stop') return deps.stopBridge({ releaseLock: true })
      const client = await deps.loadClient()
      deps.setRunning(true)
      deps.setPollAbort(new AbortController())
      void deps.pollMessages(client)
    },
  }),
}))
vi.mock('../src/queue.js', async () => {
  const actual = await vi.importActual<typeof import('../src/queue.js')>('../src/queue.js')
  return { ...actual, MessageQueue: class extends actual.MessageQueue {
    constructor(...args: ConstructorParameters<typeof actual.MessageQueue>) { super(...args); state.queue = this }
  } }
})
import extension from '../src/index.js'
import { MessageQueue } from '../src/queue.js'

describe('bridge bidirectional sync and lifecycle', () => {
  let handlers: Record<string, (event: any, ctx: any) => any>
  let commands: Record<string, any>
  let ctx: any
  let oldListeners: Map<string, Function[]>
  beforeEach(async () => {
    vi.clearAllMocks()
    state.config = {}
    state.client.sendText.mockResolvedValue(undefined)
    // No real network, credentials, locks, or user messages.
    state.client.getUpdates.mockImplementation(() => new Promise(() => {}))
    state.client.notifyStart.mockResolvedValue(undefined)
    state.client.notifyStop.mockResolvedValue(undefined)
    state.client.stopTyping.mockResolvedValue(undefined)
    handlers = {}; commands = {}
    ctx = { cwd: process.cwd(), hasUI: true, isIdle: () => true, ui: { notify: vi.fn(), setStatus: vi.fn() } }
    oldListeners = new Map(['SIGINT', 'SIGTERM', 'beforeExit'].map(name => [name, process.listeners(name)]))
    extension({
      on: (name: string, handler: any) => { handlers[name] = handler },
      registerCommand: (name: string, command: any) => { commands[name] = command },
      registerTool: vi.fn(), getActiveTools: () => [], setActiveTools: vi.fn(),
      sendUserMessage: vi.fn(),
    } as any)
    await handlers.session_start({}, ctx)
    await commands.wechat.handler('start', ctx)
  })
  afterEach(async () => {
    await handlers.session_shutdown({}, ctx)
    for (const [name, previous] of oldListeners) {
      for (const listener of process.listeners(name)) {
        if (!previous.includes(listener)) process.removeListener(name, listener as any)
      }
    }
    vi.restoreAllMocks()
  })

  it('sends TUI input and new assistant replies by default without first inbound activity', async () => {
    await handlers.agent_start({}, ctx)
    if (handlers.message_start) await handlers.message_start({ message: { role: 'user', content: [{ type: 'text', text: 'run tests' }] } }, ctx)
    else await handlers.input({ source: 'interactive', text: 'run tests' }, ctx)
    await handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'tests passed' }] } }, ctx)
    expect(state.client.sendText.mock.calls).toEqual([
      ['bound-user', '[电脑端] run tests'], ['bound-user', 'tests passed'],
    ])
    expect(state.client.notifyStart).toHaveBeenCalledTimes(1)
  })

  it('can disable TUI sync without changing the message source selection', async () => {
    state.config.bidirectionalSync = false
    await handlers.agent_start({}, ctx)
    if (handlers.message_start) await handlers.message_start({ message: { role: 'user', content: 'run tests' } }, ctx)
    else await handlers.input({ source: 'interactive', text: 'run tests' }, ctx)
    await handlers.message_end({ message: { role: 'assistant', content: 'tests passed' } }, ctx)
    expect(state.client.sendText).not.toHaveBeenCalled()
  })

  it('still delivers WeChat replies with TUI sync off and queued TUI input', async () => {
    state.config.bidirectionalSync = false
    state.queue.pendingInjection = { userId: 'bound-user' }
    if ('consumeSubmittedRequest' in MessageQueue.prototype) vi.spyOn(MessageQueue.prototype, 'consumeSubmittedRequest').mockReturnValue({ userId: 'bound-user' } as any)
    await handlers.agent_start({}, ctx)
    if (handlers.message_start) await handlers.message_start({ message: { role: 'user', content: 'wechat task' } }, ctx)
    await handlers.input({ source: 'interactive', text: 'queued TUI input' }, ctx)
    await handlers.message_end({ message: { role: 'assistant', content: 'wechat reply' } }, ctx)
    expect(state.client.sendText.mock.calls).toEqual([['bound-user', 'wechat reply']])
  })

  it('stop notifies the backend and blocks later assistant delivery', async () => {
    await commands.wechat.handler('stop', ctx)
    await handlers.message_end({ message: { role: 'assistant', content: 'later reply' } }, ctx)
    expect(state.client.notifyStop).toHaveBeenCalledTimes(1)
    expect(state.client.sendText).not.toHaveBeenCalled()
  })
})
