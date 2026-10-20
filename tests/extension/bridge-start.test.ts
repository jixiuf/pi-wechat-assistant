// ============================================================================
// 测试: /wechat start — 必须把启动交给统一路径（startPolling）
//
// 背景（2026-10 回归）：startBridge 先 deps.setRunning(true) 再调
// pollMessages(=startPolling)，而 startPolling 在 running 为 true 时直接返回，
// 于是「/wechat start」只把状态标成运行，却没走 preflight / 恢复游标 /
// prepareBridge（resumeSending + 注册微信工具）/ connect ——
// 表现为桥接看似运行、实际收不到也发不出。
// ============================================================================

import { describe, it, expect, vi } from 'vitest'
import { startBridge, type CommandDeps } from '../../src/extension/commands.js'

function makeDeps(overrides: Partial<CommandDeps> = {}) {
  const calls: string[] = []
  const deps = {
    setLatestCtx: vi.fn(),
    isRunning: vi.fn(() => false),
    lock: vi.fn(async () => ({ success: true, message: 'ok' })),
    setRunning: vi.fn(() => { calls.push('setRunning') }),
    setPollAbort: vi.fn(),
    notify: vi.fn(),
    updateStatusBar: vi.fn(),
    pollMessages: vi.fn(async () => { calls.push('pollMessages') }),
    ...overrides,
  } as unknown as CommandDeps
  return { deps, calls }
}

const ctx = {} as never

describe('/wechat start', () => {
  it('should not preset running before delegating to startPolling', async () => {
    const { deps } = makeDeps()

    await startBridge('', ctx, deps)

    // running 由 startPolling 内部设置：提前设为 true 会让 startPolling 直接返回
    expect(deps.setRunning).not.toHaveBeenCalled()
    expect(deps.pollMessages).toHaveBeenCalledTimes(1)
  })

  it('should skip when bridge is already running', async () => {
    const { deps } = makeDeps({ isRunning: vi.fn(() => true) } as Partial<CommandDeps>)

    await startBridge('', ctx, deps)

    expect(deps.lock).not.toHaveBeenCalled()
    expect(deps.pollMessages).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledWith('微信桥接已经在运行', 'info')
  })

  it('should not start polling when lock is not acquired', async () => {
    const { deps } = makeDeps({
      lock: vi.fn(async () => ({ success: false, message: '锁被占用' })),
    } as Partial<CommandDeps>)

    await startBridge('', ctx, deps)

    expect(deps.pollMessages).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledWith('锁被占用', 'error')
  })
})
