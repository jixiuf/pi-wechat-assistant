// ============================================================================
// 测试: remote-commands.ts — 会话替换/重载期间的 stale ctx/pi 降级
//
// 背景：pi 在 newSession/fork/switchSession/reload 后 invalidate 旧 runner，
// 旧 ctx 的 getter 与旧 pi API 都同步 throw（assertActive）。微信消息是分离异步
// 处理的，在途 handler 手里的 ctx/pi 随时可能失效，这里断言降级为友好提示，
// 而不是把 pi 内部文案抛给用户。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleRemoteCommand, type RemoteCommandDeps } from '../../src/extension/remote-commands.js'
import {
  clearNewSessionConfirm,
  clearSwitchConfirm,
  peekNewSessionConfirm,
  peekSwitchConfirm,
  takeSwitchConfirm,
} from '../../src/session-confirm.js'

// --- Mock: 避免读真实配置文件 ---
vi.mock('../src/auth.js', () => ({
  getConfigCache: vi.fn(() => ({})),
}))

// --- Mock: SessionManager.list（仅 sessions/goto 使用） ---
const listMock = vi.fn(async () => [] as Array<{ path: string; name?: string; modified: Date }>)
vi.mock('@mariozechner/pi-coding-agent', () => ({
  SessionManager: { list: (...args: unknown[]) => listMock(...(args as [])) },
}))

const STALE_MESSAGE =
  'This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx.'

const UNAVAILABLE_REPLY = '⚠️ 会话正在切换或扩展重载中，请稍后重试'

/** 已被会话替换/重载回收的 ctx：任何属性读取都 throw */
function makeStaleCtx() {
  const throwStale = (): never => {
    throw new Error(STALE_MESSAGE)
  }
  return {
    get sessionManager() { return throwStale() },
    get cwd() { return throwStale() },
    get model() { return throwStale() },
    get modelRegistry() { return throwStale() },
    getContextUsage: throwStale,
    isIdle: throwStale,
    abort: throwStale,
    compact: throwStale,
  }
}

/** 可用 ctx，可用 goStale() 模拟「await 期间被替换」 */
function makeLiveCtx(opts?: { sessionFile?: string; sessions?: unknown[] }) {
  const state = { stale: false }
  const sessionFile = opts?.sessionFile ?? '/tmp/s1.jsonl'
  const guard = () => {
    if (state.stale) throw new Error(STALE_MESSAGE)
  }
  const sessionManager = {
    getSessionFile: () => {
      guard()
      return sessionFile
    },
    getBranch: () => {
      guard()
      return opts?.sessions ?? []
    },
    getSessionId: () => {
      guard()
      return 'sid'
    },
  }
  return {
    ctx: {
      get sessionManager() {
        guard()
        return sessionManager
      },
      get cwd() {
        guard()
        return '/tmp/proj'
      },
      get model() {
        guard()
        return { provider: 'anthropic', id: 'claude' }
      },
      get modelRegistry() {
        guard()
        return { getAvailable: () => [], find: () => undefined }
      },
      getContextUsage: () => {
        guard()
        return null
      },
      isIdle: () => {
        guard()
        return true
      },
      abort: () => {
        guard()
      },
      compact: () => {
        guard()
      },
    },
    goStale: () => {
      state.stale = true
    },
  }
}

function makeDeps(over?: {
  ctx?: unknown
  pi?: Record<string, unknown>
  client?: { sendText: (userId: string, text: string) => Promise<void> }
}): { deps: RemoteCommandDeps; sent: string[]; pi: Record<string, unknown> } {
  const sent: string[] = []
  const client =
    over?.client ??
    {
      sendText: vi.fn(async (_userId: string, text: string) => {
        sent.push(text)
      }),
    }
  const pi = over?.pi ?? {
    sendUserMessage: vi.fn(async () => {}),
    getThinkingLevel: vi.fn(() => 'medium'),
    setThinkingLevel: vi.fn(),
    getActiveTools: vi.fn(() => ['read']),
    getAllTools: vi.fn(() => [{ name: 'read' }]),
    setActiveTools: vi.fn(),
    getSessionName: vi.fn(() => 'session'),
    setSessionName: vi.fn(),
    setModel: vi.fn(async () => true),
  }
  let current = over?.ctx ?? null
  const deps: RemoteCommandDeps = {
    pi: pi as never,
    getCtx: () => current as never,
    client: () => client as never,
    queueLength: () => 0,
    isRemoteToolsEnabled: async () => true,
  }
  return { deps, sent, pi }
}

beforeEach(() => {
  listMock.mockReset()
  listMock.mockResolvedValue([])
  clearNewSessionConfirm()
  clearSwitchConfirm()
})

describe('handleRemoteCommand — stale ctx 降级', () => {
  it('returns the friendly reply (never the pi internal message) for a stale ctx', async () => {
    const { deps, sent } = makeDeps({ ctx: makeStaleCtx() })

    const handled = await handleRemoteCommand('/status', 'u1', { sendText: async (_u, t) => { sent.push(t) } } as never, deps)

    expect(handled).toBe(true)
    expect(sent).toEqual([UNAVAILABLE_REPLY])
    expect(sent.join('\n')).not.toContain('stale after session replacement')
  })

  it('degrades to the friendly reply when the pi runtime goes stale mid-handler', async () => {
    const { ctx } = makeLiveCtx()
    const pi = {
      sendUserMessage: vi.fn(async () => {
        throw new Error(STALE_MESSAGE)
      }),
    }
    const { deps, sent } = makeDeps({ ctx, pi })

    await handleRemoteCommand('/reload', 'u1', { sendText: async (_u, t) => { sent.push(t) } } as never, deps)

    // 1) 先回「正在重载」 2) 投递失败后再回友好提示
    expect(sent).toEqual(['⏳ 正在重载本实例扩展...', UNAVAILABLE_REPLY])
    expect(sent.join('\n')).not.toContain('stale after session replacement')
  })

  it('cleans up the pending-confirm flag when the internal command cannot be delivered', async () => {
    const { ctx } = makeLiveCtx()
    const pi = { sendUserMessage: vi.fn(async () => { throw new Error(STALE_MESSAGE) }) }
    const { deps } = makeDeps({ ctx, pi })

    await handleRemoteCommand('/new', 'u1', { sendText: async () => {} } as never, deps)

    expect(peekNewSessionConfirm()).toBeNull()
  })

  it('leaves the /new confirmation pending for the new session instance on success', async () => {
    const { ctx } = makeLiveCtx()
    const { deps } = makeDeps({ ctx })

    await handleRemoteCommand('/new', 'u1', { sendText: async () => {} } as never, deps)

    expect(peekNewSessionConfirm()).toEqual({ userId: 'u1' })
  })

  it('leaves the /prev confirmation pending with the pre-filled message', async () => {
    const { ctx } = makeLiveCtx()
    const { deps } = makeDeps({ ctx })

    await handleRemoteCommand('/prev', 'u1', { sendText: async () => {} } as never, deps)

    expect(peekSwitchConfirm()).toEqual({ userId: 'u1' })
    expect(takeSwitchConfirm()).toEqual({ userId: 'u1', message: '✅ 已切到上一次的会话' })
  })

  it('cleans up the switch confirmation when delivery fails', async () => {
    const { ctx } = makeLiveCtx()
    const pi = { sendUserMessage: vi.fn(async () => { throw new Error(STALE_MESSAGE) }) }
    const { deps } = makeDeps({ ctx, pi })

    await handleRemoteCommand('/next', 'u1', { sendText: async () => {} } as never, deps)

    expect(peekSwitchConfirm()).toBeNull()
  })

  it('keeps reporting unrelated failures as command errors', async () => {
    const { ctx } = makeLiveCtx()
    const pi = {
      setModel: vi.fn(async () => {
        throw new Error('network boom')
      }),
    }
    const sent: string[] = []
    const { deps } = makeDeps({
      ctx: { ...ctx, modelRegistry: { getAvailable: () => [], find: () => ({ provider: 'p', id: 'm' }) } },
      pi,
    })

    await handleRemoteCommand('/model p/m', 'u1', { sendText: async (_u, t) => { sent.push(t) } } as never, deps)

    expect(sent).toEqual(['❌ 命令执行失败: network boom'])
  })
})

describe('handleRemoteCommand — await 期间会话被替换', () => {
  it('reads ctx.cwd before awaiting so /sessions survives a mid-await replacement', async () => {
    const { ctx, goStale } = makeLiveCtx({ sessionFile: '/tmp/s1.jsonl' })
    listMock.mockImplementation(async () => {
      // 模拟 SessionManager.list 执行期间会话被替换（旧 ctx 变 stale）
      goStale()
      return [
        { path: '/tmp/s1.jsonl', name: '当前', modified: new Date('2026-01-02T03:04:00Z') },
        { path: '/tmp/s2.jsonl', modified: new Date('2026-01-01T03:04:00Z') },
      ]
    })
    const { deps, sent } = makeDeps({ ctx })

    await handleRemoteCommand('/sessions', 'u1', { sendText: async (_u, t) => { sent.push(t) } } as never, deps)

    expect(sent.join('\n')).toContain('最近的会话')
    expect(sent.join('\n')).toContain('1. 当前')
    expect(sent.join('\n')).toContain('（当前）')
    expect(sent.join('\n')).not.toContain('stale after session replacement')
  })

  it('returns the friendly reply for /sessions when the ctx is already stale', async () => {
    const { deps, sent } = makeDeps({ ctx: makeStaleCtx() })

    await handleRemoteCommand('/sessions', 'u1', { sendText: async (_u, t) => { sent.push(t) } } as never, deps)

    expect(sent).toEqual([UNAVAILABLE_REPLY])
    expect(listMock).not.toHaveBeenCalled()
  })
})

// ============================================================================
// upstream 用例：/tools 默认禁用与开启后放行
// ============================================================================

function makeToolsDeps(opts?: { remoteToolsEnabled?: boolean }) {
  const enabled = opts?.remoteToolsEnabled ?? false
  const sendText = vi.fn()
  const client = { sendText } as any
  const deps: RemoteCommandDeps = {
    pi: {
      getActiveTools: vi.fn(() => ['read']),
      getAllTools: vi.fn(() => [{ name: 'read' }, { name: 'bash' }]),
      setActiveTools: vi.fn(),
    } as any,
    getCtx: () => null,
    client: () => client as never,
    queueLength: () => 0,
    isRemoteToolsEnabled: async () => enabled,
  }
  return { deps, client, sendText }
}

describe('微信端 /tools 开关', () => {
  it('默认禁用：返回提示且不触碰工具权限', async () => {
    const { deps, client, sendText } = makeToolsDeps({ remoteToolsEnabled: false })

    const handled = await handleRemoteCommand('/tools', 'user_1', client, deps)

    expect(handled).toBe(true)
    expect(sendText).toHaveBeenCalledTimes(1)
    const reply = sendText.mock.calls[0][1] as string
    expect(reply).toContain('默认禁用')
    expect(reply).toContain('/wechat remotetools on')
    expect((deps.pi as any).setActiveTools).not.toHaveBeenCalled()
  })

  it('禁用状态下带参数也一样拦截', async () => {
    const { deps, client, sendText } = makeToolsDeps({ remoteToolsEnabled: false })

    await handleRemoteCommand('/tools bash,read', 'user_1', client, deps)

    expect((deps.pi as any).setActiveTools).not.toHaveBeenCalled()
    expect(sendText.mock.calls[0][1]).toContain('默认禁用')
  })

  it('开启后放行：可查看与设置活跃工具', async () => {
    const { deps, client, sendText } = makeToolsDeps({ remoteToolsEnabled: true })

    await handleRemoteCommand('/tools', 'user_1', client, deps)
    expect(sendText.mock.calls[0][1]).toContain('活跃工具')

    await handleRemoteCommand('/tools bash,read', 'user_1', client, deps)
    expect((deps.pi as any).setActiveTools).toHaveBeenCalledWith(['bash', 'read'])
    expect(sendText.mock.calls[1][1]).toContain('✅')
  })
})
