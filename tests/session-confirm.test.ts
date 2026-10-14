// ============================================================================
// 测试: session-confirm.ts — 会话替换确认标志（旧实例挂 → 新实例消费）
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_SWITCH_CONFIRM_REPLY,
  NEW_SESSION_CONFIRM_REPLY,
  clearNewSessionConfirm,
  clearSwitchConfirm,
  markNewSessionConfirm,
  markSwitchConfirm,
  peekNewSessionConfirm,
  peekSwitchConfirm,
  setSwitchConfirmMessage,
  takeNewSessionConfirm,
  takeSwitchConfirm,
} from '../src/session-confirm.js'

beforeEach(() => {
  clearNewSessionConfirm()
  clearSwitchConfirm()
})

describe('/new 确认标志', () => {
  it('is empty by default', () => {
    expect(peekNewSessionConfirm()).toBeNull()
    expect(takeNewSessionConfirm()).toBeNull()
  })

  it('marks, peeks and consumes once', () => {
    markNewSessionConfirm('u1')
    expect(peekNewSessionConfirm()).toEqual({ userId: 'u1' })
    // peek 不消费
    expect(peekNewSessionConfirm()).toEqual({ userId: 'u1' })
    expect(takeNewSessionConfirm()).toEqual({ userId: 'u1' })
    expect(takeNewSessionConfirm()).toBeNull()
    expect(peekNewSessionConfirm()).toBeNull()
  })

  it('ignores malformed stored values', () => {
    ;(globalThis as Record<string, unknown>).__PI_WECHAT_NEW_SESSION_CONFIRM__ = {}
    expect(peekNewSessionConfirm()).toBeNull()
    expect(takeNewSessionConfirm()).toBeNull()
  })
})

describe('/prev /next /goto 确认标志', () => {
  it('marks with the initial message and consumes the updated one', () => {
    markSwitchConfirm('u1', '✅ 已切到上一次的会话')
    expect(peekSwitchConfirm()).toEqual({ userId: 'u1' })
    setSwitchConfirmMessage('✅ 已切到上一次的会话（09:30）')
    expect(takeSwitchConfirm()).toEqual({ userId: 'u1', message: '✅ 已切到上一次的会话（09:30）' })
    expect(peekSwitchConfirm()).toBeNull()
  })

  it('falls back to the default message when none was set', () => {
    ;(globalThis as Record<string, unknown>).__PI_WECHAT_SWITCH_CONFIRM__ = { userId: 'u2' }
    expect(takeSwitchConfirm()).toEqual({ userId: 'u2', message: DEFAULT_SWITCH_CONFIRM_REPLY })
  })

  it('does not create a flag when updating a message without a pending one', () => {
    setSwitchConfirmMessage('✅ 已切到某会话')
    expect(peekSwitchConfirm()).toBeNull()
  })

  it('is empty by default', () => {
    expect(peekSwitchConfirm()).toBeNull()
    expect(takeSwitchConfirm()).toBeNull()
  })
})

describe('回复文案', () => {
  it('is stable', () => {
    expect(NEW_SESSION_CONFIRM_REPLY).toBe('✅ 已开启新会话')
    expect(DEFAULT_SWITCH_CONFIRM_REPLY).toBe('✅ 已切换会话')
  })
})
