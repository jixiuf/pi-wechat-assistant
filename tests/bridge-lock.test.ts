import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const files = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), unlink: vi.fn(), open: vi.fn() }))
vi.mock('node:fs/promises', () => files)
import { inspectBridgeLock, describeBridgeLock } from '../src/bridge-lock.js'
import { acquireLock, saveContextTokensThrottled, flushContextTokens } from '../src/auth.js'

describe('bridge lock diagnostics', () => {
  const owner = { pid: 123456, sessionId: 'other-session' }
  beforeEach(() => {
    vi.clearAllMocks()
    files.readFile.mockResolvedValue(JSON.stringify(owner))
    files.open.mockResolvedValue({ close: vi.fn() })
    files.writeFile.mockResolvedValue(undefined)
    files.mkdir.mockResolvedValue(undefined)
    files.chmod.mockResolvedValue(undefined)
    vi.spyOn(process, 'kill').mockReturnValue(true)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
  it('waits for a timer write before flushing handoff state', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    files.writeFile.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    saveContextTokensThrottled({ lastUserId: 'user', tokens: { user: 'old' } })
    await vi.advanceTimersByTimeAsync(5_000)
    const flushed = flushContextTokens({ lastUserId: 'user', tokens: { user: 'new' } })
    await Promise.resolve()
    expect(files.writeFile).toHaveBeenCalledTimes(1)
    finish()
    await flushed
    expect(files.writeFile).toHaveBeenCalledTimes(2)
    expect(files.writeFile.mock.calls[1][1]).toContain('new')
  })
  it('reports a live other owner without claiming that polling is healthy', async () => {
    const state = await inspectBridgeLock('mock-lock')
    expect(state).toEqual({ kind: 'other', ...owner })
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 0)
    expect(describeBridgeLock(state)).toContain('/wechat stop')
    expect(describeBridgeLock(state)).not.toContain('tmux')
    expect((await acquireLock('new-session')).success).toBe(false)
    expect(files.writeFile).not.toHaveBeenCalled()
  })
  it.each(['EPERM', 'EACCES', 'UNKNOWN'])('does not steal a lock when the PID probe fails with %s', async code => {
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('probe'), { code }) })
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'unknown', pid: owner.pid })
    expect((await acquireLock('new-session')).success).toBe(false)
    expect(files.writeFile).not.toHaveBeenCalled()
  })
  it('allows a lock whose owner is confirmed to have exited', async () => {
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }) })
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'stale' })
    expect((await acquireLock('new-session')).success).toBe(true)
    expect(files.writeFile).toHaveBeenCalledTimes(1)
  })
  it('allows an absent lock', async () => {
    files.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect(await inspectBridgeLock('mock-lock')).toEqual({ kind: 'missing' })
    expect((await acquireLock('new-session')).success).toBe(true)
  })
  it.each(['invalid-json', '{}', '{"pid":-1,"sessionId":"x"}', '{"pid":0,"sessionId":"x"}', '{"pid":"123","sessionId":"x"}', '{"pid":1.5,"sessionId":"x"}'])('rejects malformed locks without probing PIDs: %s', async contents => {
    files.readFile.mockResolvedValue(contents)
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'unknown' })
    expect((await acquireLock('new-session')).success).toBe(false)
    expect(process.kill).not.toHaveBeenCalled()
    expect(files.writeFile).not.toHaveBeenCalled()
  })
  it('does not treat unreadable state as missing', async () => {
    files.readFile.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'unknown' })
    expect((await acquireLock('new-session')).success).toBe(false)
  })
  it('renews only the matching current-process session', async () => {
    files.readFile.mockResolvedValue(JSON.stringify({ pid: process.pid, sessionId: 'mine' }))
    expect(await inspectBridgeLock('mock-lock')).toMatchObject({ kind: 'current' })
    expect(process.kill).not.toHaveBeenCalled()
    expect((await acquireLock('mine')).success).toBe(true)
    expect((await acquireLock('different')).success).toBe(false)
    expect(files.writeFile).not.toHaveBeenCalled()
  })
})
