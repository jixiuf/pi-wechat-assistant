import { describe, expect, it } from 'vitest'
import { formatWechatStatus, WECHAT_STATUS_ICON, type WechatStatusState } from '../src/status.js'

const active: WechatStatusState = { running: true, bidirectional: true, pending: 0, sendFailed: false }
const plain = { NO_COLOR: '1' }

describe('compact WeChat footer', () => {
  it('uses an unframed WeChat logo and shows the two-way arrow only when enabled', () => {
    expect(formatWechatStatus(active, plain)).toBe(`${WECHAT_STATUS_ICON} ⇄ ▶`)
    expect(formatWechatStatus({ ...active, bidirectional: false }, plain)).toBe(`${WECHAT_STATUS_ICON} ▶`)
  })

  it('only adds pending messages and failed sending to the running state', () => {
    const pending = { ...active, pending: 2, sendFailed: true }
    expect(formatWechatStatus(pending, plain)).toBe(`${WECHAT_STATUS_ICON} ⇄ ▶ | 待处理:2 | 发送失败`)
    expect(formatWechatStatus({ ...pending, running: false }, plain)).toBe(`${WECHAT_STATUS_ICON} ⏸`)
  })

  it.each(['truecolor', '24bit', 'TRUECOLOR'])('uses WeChat green for the logo and running indicator on %s terminals', COLORTERM => {
    expect(formatWechatStatus(active, { COLORTERM })).toBe(`\x1b[38;2;7;193;96m${WECHAT_STATUS_ICON}\x1b[39m ⇄ \x1b[38;2;7;193;96m▶\x1b[39m`)
  })

  it('uses a red stopped indicator while preserving the green logo', () => {
    expect(formatWechatStatus({ ...active, running: false }, { COLORTERM: 'truecolor' })).toBe(`\x1b[38;2;7;193;96m${WECHAT_STATUS_ICON}\x1b[39m \x1b[38;2;239;68;68m⏸\x1b[39m`)
  })

  it('falls back to a white logo and standard ANSI green without truecolor support', () => {
    expect(formatWechatStatus(active, { TERM: 'xterm-256color' })).toBe(`\x1b[37m${WECHAT_STATUS_ICON}\x1b[39m ⇄ \x1b[32m▶\x1b[39m`)
  })

  it('falls back to standard ANSI red for the stopped indicator', () => {
    expect(formatWechatStatus({ ...active, running: false }, { TERM: 'xterm-256color' })).toBe(`\x1b[37m${WECHAT_STATUS_ICON}\x1b[39m \x1b[31m⏸\x1b[39m`)
  })

  it.each([{ NO_COLOR: '1', COLORTERM: 'truecolor' }, { TERM: 'dumb', COLORTERM: 'truecolor' }])('omits all ANSI color when disabled: %j', env => {
    expect(formatWechatStatus(active, env)).toBe(`${WECHAT_STATUS_ICON} ⇄ ▶`)
    expect(formatWechatStatus({ ...active, running: false }, env)).toBe(`${WECHAT_STATUS_ICON} ⏸`)
  })

  it('allows a text fallback for terminals without Nerd Font glyphs', () => {
    expect(formatWechatStatus(active, { ...plain, PI_WECHAT_STATUS_ICON: 'text' })).toBe('微信 ⇄ ▶')
    expect(formatWechatStatus({ ...active, bidirectional: false }, { ...plain, PI_WECHAT_STATUS_ICON: 'text' })).toBe('微信 ▶')
  })
})
