import { describe, expect, it } from 'vitest'
import { ModelFailureNotice, summarizeModelError } from '../src/model-failure.js'

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
    expect(failure.take(false)).toContain('可能自动重试')
    failure.startAttempt()
    failure.observe({ stopReason: 'error', errorMessage: 'quota again' })
    expect(failure.take(false)).toBeNull()
    failure.reset()
    failure.observe({ stopReason: 'error', errorMessage: 'quota again' })
    expect(failure.take(false)).not.toBeNull()
  })
  it('requires a terminal error boundary and honors a subsequently aborted signal', () => {
    const failure = new ModelFailureNotice()
    const abort = new AbortController()
    failure.observe({ stopReason: 'error', errorMessage: 'quota' }, abort.signal)
    expect(failure.take(true)).toBeNull()
    failure.beforeSettle('error')
    abort.abort()
    expect(failure.take(true)).toBeNull()
  })
})
