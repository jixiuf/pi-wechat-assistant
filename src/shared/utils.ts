// ============================================================================
// 通用工具函数
// ============================================================================

import qrcode from 'qrcode-terminal'
import { PREVIEW_LIMIT } from './constants.js'

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

export function fail(text: string) {
  return { content: [{ type: 'text' as const, text: `❌ ${text}` }], details: {} }
}

export async function renderQrCode(url: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (code) => resolve(code))
  })
}

export function extractTextFromMessageContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  const text = content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  return text || null
}

export function summarizePreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= PREVIEW_LIMIT ? normalized : `${normalized.slice(0, PREVIEW_LIMIT - 1)}…`
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * pi 在会话替换（newSession/fork/switchSession）或扩展重载后会 invalidate 旧 runner，
 * 旧 ctx 的属性 getter 与旧 pi API 都会同步 throw（assertActive）。
 * 这里统一识别该错误，用于降级为友好提示，而不是把 pi 内部文案直接抛给用户。
 */
const STALE_EXTENSION_ERROR_MARKER = 'is stale after session replacement or reload'

export function isStaleExtensionError(error: unknown): boolean {
  return formatError(error).includes(STALE_EXTENSION_ERROR_MARKER)
}

/**
 * 探测 ctx 是否仍可用（未被会话替换/重载回收）。
 * ctx 是惰性对象，属性 getter 内部会 assertActive() 直接 throw，故必须 try/catch。
 * 注意：ctx 与 pi runtime 同属一个 runner，ctx 失效即 pi 调用同样会 throw。
 */
export function isCtxUsable(ctx: unknown): boolean {
  if (!ctx) return false
  try {
    void (ctx as { sessionManager?: unknown }).sessionManager
    return true
  } catch {
    return false
  }
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}
