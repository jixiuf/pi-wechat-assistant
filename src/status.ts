// Compact footer only; credentials and send diagnostics remain in /wechat status.
// Font Awesome Weixin / Nerd Font nf-fa-weixin (U+F1D7).
export const WECHAT_STATUS_ICON = '\uf1d7'

export interface WechatStatusState {
  running: boolean
  bidirectional: boolean
  pending: number
  sendFailed: boolean
}

export function formatWechatStatus(state: WechatStatusState, env: NodeJS.ProcessEnv = process.env): string {
  // A terminal cannot reliably report missing font glyphs. Allow an explicit text fallback.
  const label = env.PI_WECHAT_STATUS_ICON === 'text' ? '微信' : WECHAT_STATUS_ICON
  const canColor = !env.NO_COLOR && env.TERM !== 'dumb'
  const trueColor = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')
  const paint = (text: string, rgb: string, ansi: number): string => canColor
    ? `\x1b[${trueColor ? '38;2;' + rgb : ansi}m${text}\x1b[39m`
    : text
  const icon = paint(label, '7;193;96', 37)
  const indicator = state.running ? paint('▶', '7;193;96', 32) : paint('⏸', '239;68;68', 31)

  const parts = [state.running
    ? `${icon}${state.bidirectional ? ' ⇄' : ''} ${indicator}`
    : `${icon} ${indicator}`]
  if (state.running && state.pending > 0) parts.push(`待处理:${state.pending}`)
  if (state.running && state.sendFailed) parts.push('发送失败')
  return parts.join(' | ')
}
