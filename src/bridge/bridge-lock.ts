import { readFile } from 'node:fs/promises'

export type BridgeLockState =
  | { kind: 'missing' }
  | { kind: 'unknown'; reason: string; pid?: number }
  | { kind: 'current' | 'other' | 'stale'; pid: number; sessionId: string; protocol?: number }

/** Read-only diagnostic. A live PID is evidence of lock ownership, not bridge health. */
export async function inspectBridgeLock(file: string): Promise<BridgeLockState> {
  let value: unknown
  try { value = JSON.parse(await readFile(file, 'utf8')) }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' } : { kind: 'unknown', reason: '锁文件不可读或格式无效' }
  }
  const lock = value as { pid?: unknown; sessionId?: unknown; protocol?: unknown } | null
  if (!lock || typeof lock.pid !== 'number' || !Number.isSafeInteger(lock.pid) || lock.pid <= 0
    || typeof lock.sessionId !== 'string' || !lock.sessionId.trim()) {
    return { kind: 'unknown', reason: '锁文件内容无效' }
  }
  const owner = { pid: lock.pid, sessionId: lock.sessionId, ...(lock.protocol === 1 ? { protocol: 1 } : {}) }
  if (lock.pid === process.pid) return { kind: 'current', ...owner }
  try { process.kill(lock.pid, 0); return { kind: 'other', ...owner } }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ESRCH' ? { kind: 'stale', ...owner }
      : { kind: 'unknown', pid: lock.pid, reason: code === 'EPERM' ? '无权限检查持锁进程' : '无法检查持锁进程' }
  }
}

export function describeBridgeLock(state: BridgeLockState): string {
  switch (state.kind) {
    case 'other': return `其他 pi 进程持有微信桥接锁（PID ${state.pid}）。本会话不能直接发送；请切换到持锁会话操作，或先在那里执行 /wechat stop，再在本会话执行 /wechat start。`
    case 'current': return `本进程持有微信桥接锁（PID ${state.pid}），实际运行状态以本会话状态为准。`
    case 'stale': return `旧桥接进程已退出（PID ${state.pid}），启动时可接管失效锁。`
    case 'missing': return '未发现微信桥接锁。'
    case 'unknown': return `无法确认微信桥接锁状态${state.pid ? `（PID ${state.pid}）` : ''}：${state.reason}。请检查文件或进程权限，不会自动接管。`
  }
}
