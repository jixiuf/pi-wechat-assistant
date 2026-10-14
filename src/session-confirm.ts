// ============================================================================
// 会话替换确认标志（跨「旧实例 → 新实例」传递）
//
// /new /prev /next /goto 由旧实例投递内部命令触发会话替换，但旧实例的 client
// 已在 session_shutdown 里被 dispose，成功的确认消息发不出去；
// 因此把「待确认」写进 globalThis，由新实例在 session_start 里消费并发送。
// 消费即清除：避免残留到下一次 session_start（如 /reload）造成误导性确认。
// ============================================================================

const NEW_SESSION_KEY = '__PI_WECHAT_NEW_SESSION_CONFIRM__'
const SWITCH_SESSION_KEY = '__PI_WECHAT_SWITCH_CONFIRM__'

/** /new 成功后的确认文案（由新实例发送） */
export const NEW_SESSION_CONFIRM_REPLY = '✅ 已开启新会话'

/** 切换确认文案缺失时的兜底（正常由切换 handler 补全为「已切到上一次的会话（xx）」） */
export const DEFAULT_SWITCH_CONFIRM_REPLY = '✅ 已切换会话'

export interface NewSessionConfirm {
  userId: string
}

export interface SwitchConfirm {
  userId: string
  message: string
}

function store(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>
}

// --- /new ---

export function markNewSessionConfirm(userId: string): void {
  store()[NEW_SESSION_KEY] = { userId }
}

export function peekNewSessionConfirm(): NewSessionConfirm | null {
  const pending = store()[NEW_SESSION_KEY] as { userId?: string } | undefined
  return pending?.userId ? { userId: pending.userId } : null
}

export function clearNewSessionConfirm(): void {
  delete store()[NEW_SESSION_KEY]
}

/** 消费（并清除）待发送的 /new 确认 */
export function takeNewSessionConfirm(): NewSessionConfirm | null {
  const pending = peekNewSessionConfirm()
  if (!pending) return null
  clearNewSessionConfirm()
  return pending
}

// --- /prev /next /goto ---

export function markSwitchConfirm(userId: string, message: string): void {
  store()[SWITCH_SESSION_KEY] = { userId, message }
}

export function peekSwitchConfirm(): { userId: string } | null {
  const pending = store()[SWITCH_SESSION_KEY] as { userId?: string } | undefined
  return pending?.userId ? { userId: pending.userId } : null
}

/** 确定目标会话后补全确认文案（带目标会话名）；无待确认标志时不做任何事 */
export function setSwitchConfirmMessage(message: string): void {
  const pending = peekSwitchConfirm()
  if (!pending) return
  store()[SWITCH_SESSION_KEY] = { userId: pending.userId, message }
}

export function clearSwitchConfirm(): void {
  delete store()[SWITCH_SESSION_KEY]
}

/** 消费（并清除）待发送的切换确认 */
export function takeSwitchConfirm(): SwitchConfirm | null {
  const pending = peekSwitchConfirm()
  if (!pending) return null
  const raw = store()[SWITCH_SESSION_KEY] as { message?: string } | undefined
  clearSwitchConfirm()
  return { userId: pending.userId, message: raw?.message ?? DEFAULT_SWITCH_CONFIRM_REPLY }
}
