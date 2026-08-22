// ============================================================================
// 微信选项式问卷 — 回复解析 + 问题消息格式化 + 桥接 API 类型
// ============================================================================

export interface QuestionOption {
  label: string
  description?: string
}

export type ParsedQuestionAnswer =
  | { kind: 'option'; index: number; label: string }
  | { kind: 'multi'; indices: number[]; labels: string[] }
  | { kind: 'custom'; text: string }
  | { kind: 'cancel' }
  | { kind: 'invalid' }

/** 等待微信回复的默认超时（5 分钟） */
export const DEFAULT_QUESTION_TIMEOUT_MS = 5 * 60 * 1000

/** 选项描述最大展示长度（避免微信消息过长） */
const DESC_MAX_LENGTH = 80

export function getQuestionTimeoutMs(): number {
  const envValue = Number(process.env.PI_WECHAT_QUESTION_TIMEOUT_MS)
  return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_QUESTION_TIMEOUT_MS
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * 解析微信回复文本为问卷答案。
 *
 * - "0" → cancel（取消/放弃回答）
 * - 合法数字（1..optionCount）→ 单选取第一个 / 多选全部
 * - 数字越界 → invalid（提示重发，不结束等待）
 * - 其他文本 → custom（自定义答案）
 */
export function parseQuestionAnswer(
  text: string,
  options: QuestionOption[],
  multiSelect: boolean,
): ParsedQuestionAnswer {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'invalid' }
  if (trimmed === '0') return { kind: 'cancel' }

  const listMatch = trimmed.match(/^\d+(?:\s*[,，、\s]\s*\d+)*$/)
  if (listMatch) {
    const numbers = trimmed.split(/[,，、\s]+/).map((s) => parseInt(s, 10))
    const optionCount = options.length
    const allValid = numbers.length > 0 && numbers.every((n) => n >= 1 && n <= optionCount)

    if (allValid) {
      if (multiSelect) {
        return {
          kind: 'multi',
          indices: numbers,
          labels: numbers.map((n) => options[n - 1].label),
        }
      }
      const n = numbers[0]
      return { kind: 'option', index: n, label: options[n - 1].label }
    }

    // 数字越界 → 提示重发
    return { kind: 'invalid' }
  }

  return { kind: 'custom', text: trimmed }
}

/**
 * 格式化问题消息，发送到微信展示。
 */
export function formatQuestionMessage(opts: {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
  index?: number
  total?: number
}): string {
  const header = opts.header ? `｜${opts.header}` : ''
  const prefix = opts.total && opts.total > 1 ? `问题 ${opts.index ?? 1}/${opts.total}` : '问题'
  const multiLabel = opts.multiSelect ? '（多选）' : ''

  const lines: string[] = [`📋 ${prefix}${multiLabel}${header}：${opts.question}`, '']
  opts.options.forEach((o, i) => {
    const desc = o.description ? ` — ${truncate(o.description, DESC_MAX_LENGTH)}` : ''
    lines.push(`[${i + 1}] ${o.label}${desc}`)
  })
  lines.push('')
  lines.push(
    opts.multiSelect
      ? '💬 回复多个数字选择（如 1,3）；直接输入文字 = 自定义答案；回复 0 = 取消'
      : '💬 回复数字选择；直接输入文字 = 自定义答案；回复 0 = 取消',
  )
  return lines.join('\n')
}

/**
 * 微信问卷桥接 API — 由 pi-wechat-assistant 挂到 globalThis.__PI_WECHAT_BRIDGE__，
 * 供 ask-user-question-rpc 等扩展在微信触发的 turn 中委托提问。
 */
export interface WechatQuestionBridge {
  /** 当前 turn 是否由微信触发（微信用户可见并可直接回复） */
  isWechatTurnActive(): boolean
  /** 当前微信 turn 的目标用户 ID（无则返回 null） */
  getActiveUserId(): string | null
  /**
   * 通过微信向用户提问，挂起等待回复。
   * 返回 null 表示超时 / 被取消 / 桥接不可用。
   */
  askQuestion(opts: {
    userId?: string
    question: string
    header?: string
    options: QuestionOption[]
    multiSelect?: boolean
    index?: number
    total?: number
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{
    kind: 'option' | 'custom' | 'multi' | 'chat'
    answer: string | null
    selected?: string[]
  } | null>
}
