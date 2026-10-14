import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { acquireBridgeLock, releaseBridgeLock, requestBridgeHandoff, handoffRequested } from '../../src/bridge/bridge-ownership.js'
import { inspectBridgeLock } from '../../src/bridge/bridge-lock.js'

describe('cooperative ownership with real filesystem contention', () => {
  let directory: string
  let file: string
  beforeEach(async () => {
    const root = path.resolve('node_modules/.cache')
    await fs.mkdir(root, { recursive: true })
    directory = await fs.mkdtemp(path.join(root, 'bridge-ownership-'))
    file = path.join(directory, 'session.lock')
  })
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })
  const owner = () => ({ kind: 'current' as const, pid: process.pid, sessionId: 'old', protocol: 1 })

  it('allows only one concurrent acquisition', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireBridgeLock(file, `session-${i}`)))
    expect(results.filter(result => result.success)).toHaveLength(1)
  })

  it('never releases a different instance, including a restart in the same process', async () => {
    await acquireBridgeLock(file, 'new')
    await releaseBridgeLock(file, 'old')
    expect(await inspectBridgeLock(file)).toMatchObject({ sessionId: 'new' })
  })

  it('requests draining without replacing ownership and waits for release', async () => {
    await acquireBridgeLock(file, 'old')
    const pending = requestBridgeHandoff(file, owner(), 2_000)
    await expect.poll(() => handoffRequested(file, 'old')).toBe(true)
    expect(await handoffRequested(file, 'new')).toBe(false)
    expect((await acquireBridgeLock(file, 'new')).success).toBe(false)
    await releaseBridgeLock(file, 'old')
    await pending
    expect((await acquireBridgeLock(file, 'new')).success).toBe(true)
    expect(await handoffRequested(file, 'old')).toBe(false)
  })

  it('leaves the old lock intact on timeout and removes the request', async () => {
    await acquireBridgeLock(file, 'old')
    await expect(requestBridgeHandoff(file, owner(), 40)).rejects.toThrow('超时')
    expect(await inspectBridgeLock(file)).toMatchObject({ sessionId: 'old' })
    expect(await handoffRequested(file, 'old')).toBe(false)
  })

  it('cancels a pending request without stealing the lock', async () => {
    await acquireBridgeLock(file, 'old')
    const abort = new AbortController()
    const pending = requestBridgeHandoff(file, owner(), 2_000, abort.signal)
    const rejected = expect(pending).rejects.toThrow()
    await expect.poll(() => handoffRequested(file, 'old')).toBe(true)
    abort.abort()
    await rejected
    expect(await inspectBridgeLock(file)).toMatchObject({ sessionId: 'old' })
    expect(await handoffRequested(file, 'old')).toBe(false)
  })

  it('rejects an owner that changed while the confirmation dialog was open', async () => {
    await acquireBridgeLock(file, 'new')
    await expect(requestBridgeHandoff(file, owner())).rejects.toThrow('已变化')
    expect(await handoffRequested(file, 'new')).toBe(false)
  })

  it('requires manual stop for legacy owners', async () => {
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, sessionId: 'legacy' }))
    await expect(requestBridgeHandoff(file, { ...owner(), sessionId: 'legacy', protocol: undefined })).rejects.toThrow('不支持')
    expect(await inspectBridgeLock(file)).toMatchObject({ sessionId: 'legacy' })
  })

  it('serializes stale-lock cleanup as well as initial creation', async () => {
    // The child has exited: use a confirmed ESRCH PID rather than assuming an arbitrary PID is dead.
    const { spawnSync } = await import('node:child_process')
    const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
    expect(child.status).toBe(0)
    await fs.writeFile(file, JSON.stringify({ pid: child.pid, sessionId: 'stale' }))
    expect(await inspectBridgeLock(file)).toMatchObject({ kind: 'stale' })
    const results = await Promise.all(['a', 'b', 'c'].map(id => acquireBridgeLock(file, id)))
    expect(results.filter(result => result.success)).toHaveLength(1)
  })
})
