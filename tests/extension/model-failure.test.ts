import { describe, expect, it } from 'vitest'
import { ModelFailureNotice, summarizeModelError, failureNoticeMode } from '../../src/extension/model-failure.js'

describe('structured model failure notices', () => {
  it('redacts common credential forms and URL query/userinfo before truncating', () => {
    const summary = summarizeModelError('Authorization: Bearer private-token api_key="secret value" sk-private-key https://user:pass@example.com/v1?token=hidden#secret')
    for (const secret of ['private-token', 'secret value', 'sk-private-key', 'user:pass', 'token=hidden', '#secret']) {
      expect(summary).not.toContain(secret)
    }
    expect(summary).toContain('https://example.com/v1')
  })
  it('normalizes diagnostics and limits by Unicode code points', () => {
    expect(summarizeModelError('\u001b[31mrate\nlimit\u001b[0m')).toBe('rate limit')
    expect(summarizeModelError('')).toContain('未提供错误详情')
    expect(summarizeModelError('😀'.repeat(301))).toBe('😀'.repeat(300) + '…')
  })
  it('claims a notice once per user request, retaining the claim across retry loops', () => {
    const failure = new ModelFailureNotice()
    failure.observe({ stopReason: 'error', errorMessage: 'quota' })
    expect(failure.take('attempt')).toContain('可能自动重试')
    failure.startAttempt()
    failure.observe({ stopReason: 'error', errorMessage: 'quota again' })
    expect(failure.take('attempt')).toBeNull()
    failure.reset()
    failure.observe({ stopReason: 'error', errorMessage: 'quota again' })
    expect(failure.take('attempt')).not.toBeNull()
  })
  it('distinguishes public host signatures before any request runs', () => {
    expect(failureNoticeMode({} as any, undefined)).toBe('attempt')
    expect(failureNoticeMode({ isProjectTrusted: () => true } as any, undefined)).toBe('settled')
    expect(failureNoticeMode({ isProjectTrusted: () => true } as any, () => {})).toBe('boundary')
  })
  it('requires an error boundary on both the first and subsequent requests', () => {
    const failure = new ModelFailureNotice()
    for (let i = 0; i < 2; i++) {
      failure.observe({ stopReason: 'error', errorMessage: 'quota' })
      expect(failure.take('boundary')).toBeNull()
      failure.beforeSettle('error')
      expect(failure.take('boundary')).toContain('自动处理已结束')
      expect(failure.take('boundary')).toBeNull()
      failure.reset()
    }
  })
  it('uses conservative settlement wording and does not change capability after an observed boundary', () => {
    const failure = new ModelFailureNotice()
    failure.beforeSettle('completed')
    failure.reset()
    failure.observe({ stopReason: 'error', errorMessage: 'quota' })
    expect(failure.take('settled')).toBe('⚠️ 此前一次模型请求失败：quota')
    expect(failure.take('settled')).toBeNull()
  })
  it.each(['attempt', 'settled', 'boundary'] as const)('honors an aborted signal in %s mode', mode => {
    const failure = new ModelFailureNotice()
    const abort = new AbortController()
    failure.observe({ stopReason: 'error', errorMessage: 'quota' }, abort.signal)
    failure.beforeSettle('error')
    abort.abort()
    expect(failure.take(mode)).toBeNull()
  })
})