import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { inspectBridgeLock, describeBridgeLock, type BridgeLockState } from './bridge-lock.js'

export type BridgeOwner = Extract<BridgeLockState, { sessionId: string }>

/** Serializes new-protocol writers, including stale-lock cleanup and release.
 * A crashed writer leaves the mutex in place: fail closed rather than guessing ownership.
 */
async function exclusive<T>(file: string, action: () => Promise<T>): Promise<T> {
  let handle
  for (let i = 0; ; i++) {
    try { handle = await fs.open(file + '.mutex', 'wx', 0o600); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || i === 49) throw new Error('桥接锁正在更新或遗留 mutex 未清理，请确认其他会话状态后重试。')
      await delay(10)
    }
  }
  try { return await action() }
  finally { await handle.close(); await fs.unlink(file + '.mutex') }
}

const sameOwner = (a: BridgeLockState, b: { pid: number; sessionId: string }) =>
  'sessionId' in a && a.pid === b.pid && a.sessionId === b.sessionId
const requestFile = (file: string, sessionId: string) => file + '.handoff-' + createHash('sha256').update(sessionId).digest('hex')

export async function acquireBridgeLock(file: string, sessionId: string): Promise<{ success: boolean; message: string }> {
  try {
    return await exclusive(file, async () => {
      const state = await inspectBridgeLock(file)
      if (state.kind === 'current' && state.sessionId === sessionId) return { success: true, message: '已持有锁' }
      if (state.kind !== 'missing' && state.kind !== 'stale') return { success: false, message: describeBridgeLock(state) }
      if (state.kind === 'stale') await fs.unlink(file)
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, sessionId, protocol: 1, timestamp: Date.now() }), { flag: 'wx', mode: 0o600 })
      return { success: true, message: '成功获取锁' }
    })
  } catch (error) { return { success: false, message: String(error) } }
}

export async function releaseBridgeLock(file: string, sessionId: string): Promise<void> {
  await exclusive(file, async () => {
    const state = await inspectBridgeLock(file)
    if (state.kind === 'current' && state.sessionId === sessionId) await fs.unlink(file)
  })
}

/** Only protocol-1 owners are asked to drain; never replace their lock. */
export async function requestBridgeHandoff(file: string, expected: BridgeOwner, timeoutMs = 30_000, signal?: AbortSignal): Promise<void> {
  if (expected.protocol !== 1) throw new Error('旧会话不支持协作交接，请先在那里执行 /wechat stop。')
  const destination = requestFile(file, expected.sessionId)
  const requestId = randomUUID()
  const expiresAt = Date.now() + timeoutMs
  await exclusive(file, async () => {
    signal?.throwIfAborted()
    const state = await inspectBridgeLock(file)
    if (!sameOwner(state, expected) || state.kind === 'stale') throw new Error('持锁会话已变化，请重新执行 /wechat start 确认。')
    await fs.writeFile(destination, JSON.stringify({ requestId, sessionId: expected.sessionId, expiresAt }), { mode: 0o600 })
  })
  try {
    while (Date.now() < expiresAt) {
      signal?.throwIfAborted()
      const state = await inspectBridgeLock(file)
      if (state.kind === 'missing') return
      if (!sameOwner(state, expected)) throw new Error('持锁会话已变化，未自动接管，请重新确认。')
      await delay(Math.min(100, Math.max(1, expiresAt - Date.now())), undefined, { signal })
    }
    throw new Error('等待旧会话释放超时，未启动本会话桥接。请先在旧会话执行 /wechat stop。')
  } finally {
    await exclusive(file, async () => {
      try {
        const current = JSON.parse(await fs.readFile(destination, 'utf8'))
        if (current.requestId === requestId) await fs.unlink(destination)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })
  }
}

export async function handoffRequested(file: string, sessionId: string): Promise<boolean> {
  try {
    const request = JSON.parse(await fs.readFile(requestFile(file, sessionId), 'utf8'))
    return request.sessionId === sessionId && typeof request.expiresAt === 'number' && request.expiresAt > Date.now()
  } catch { return false }
}
