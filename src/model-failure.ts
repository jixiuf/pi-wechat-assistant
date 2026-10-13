import type { ExtensionContext } from '@mariozechner/pi-coding-agent'

/** Capability shared by the settled-event hosts in our published API matrix. */
export function hasSettledEvents(ctx: ExtensionContext): boolean {
  return typeof (ctx as ExtensionContext & { isProjectTrusted?: unknown }).isProjectTrusted === 'function'
}

/** Provider diagnostics only; never infer failure from assistant/tool text. */
export function summarizeModelError(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '模型服务未提供错误详情，请在 Pi 中查看。'
  const text = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/https?:\/\/[^\s<>"']+/g, url => {
      try { const parsed = new URL(url); return parsed.origin + parsed.pathname } catch { return '[URL]' }
    })
    .replace(/\bBearer\s+[^\s,"'}]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,"'}]+)/gi, '$1[已隐藏]')
    .replace(/\bsk-[\w-]+/g, '[已隐藏]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim()
  const points = Array.from(text)
  return points.length > 300 ? points.slice(0, 300).join('') + '…' : text
}

export class ModelFailureNotice {
  private error: string | null = null
  private notified = false
  private boundaryError = false
  private signal: AbortSignal | undefined

  reset(): void {
    this.error = null
    this.notified = false
    this.boundaryError = false
    this.signal = undefined
  }

  // Automatic retries start another loop without a new user request.
  startAttempt(): void { this.boundaryError = false }

  observe(message: { stopReason?: string; errorMessage?: string }, signal?: AbortSignal): void {
    this.signal = signal
    this.boundaryError = false
    this.error = message.stopReason === 'error' && !signal?.aborted
      ? summarizeModelError(message.errorMessage) : null
  }

  beforeSettle(outcome: string): void { this.boundaryError = outcome === 'error' }

  take(final: boolean, aborted = false): string | null {
    if (!this.error || this.notified || aborted || this.signal?.aborted || (final && !this.boundaryError)) return null
    // Claim before awaiting transport; do not duplicate on a repeated event or ambiguous send failure.
    this.notified = true
    return final
      ? `⚠️ 模型请求失败：${this.error}\n本次自动处理已结束，请检查后重试。`
      : `⚠️ 本次模型请求失败：${this.error}\nPi 可能自动重试；这不表示整个任务已停止。`
  }
}
