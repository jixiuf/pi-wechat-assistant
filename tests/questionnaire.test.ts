// ============================================================================
// 测试: questionnaire.ts — 微信选项式问卷解析/格式化 + MessageQueue 问答状态机
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseQuestionAnswer,
  formatQuestionMessage,
  getQuestionTimeoutMs,
  DEFAULT_QUESTION_TIMEOUT_MS,
} from '../src/questionnaire.js'
import { MessageQueue } from '../src/queue.js'
import type { IncomingMessage } from '../src/types.js'

vi.mock('../src/auth.js', () => ({
  getConfigCache: vi.fn(() => ({})),
}))

const OPTIONS = [
  { label: '指定群聊', description: '告诉我群名或群 ID' },
  { label: '指定联系人', description: '告诉我联系人姓名或 open_id' },
  { label: '先查看会话列表', description: '我先拉取你的会话列表' },
]

function makeQueue(opts?: { client?: ReturnType<typeof vi.fn>; running?: boolean }) {
  const client = opts?.client ?? vi.fn().mockReturnValue(null)
  const running = opts?.running ?? true
  const queue = new MessageQueue(
    () => client() as any,
    () => running,
    () => true,
    () => undefined as any,
    () => null as any,
    vi.fn(),
    vi.fn(),
  )
  return { queue, client }
}

describe('parseQuestionAnswer', () => {
  it('parses single option by number', () => {
    expect(parseQuestionAnswer('2', OPTIONS, false)).toEqual({
      kind: 'option',
      index: 2,
      label: '指定联系人',
    })
  })

  it('treats "0" as cancel', () => {
    expect(parseQuestionAnswer('0', OPTIONS, false)).toEqual({ kind: 'cancel' })
  })

  it('parses custom text', () => {
    expect(parseQuestionAnswer('自定义内容', OPTIONS, false)).toEqual({
      kind: 'custom',
      text: '自定义内容',
    })
  })

  it('single-select takes first number from a list', () => {
    expect(parseQuestionAnswer('1,3', OPTIONS, false)).toEqual({
      kind: 'option',
      index: 1,
      label: '指定群聊',
    })
  })

  it('multi-select parses a list of numbers', () => {
    expect(parseQuestionAnswer('1,3', OPTIONS, true)).toEqual({
      kind: 'multi',
      indices: [1, 3],
      labels: ['指定群聊', '先查看会话列表'],
    })
  })

  it('multi-select accepts space or Chinese separators', () => {
    expect(parseQuestionAnswer('1 2，3', OPTIONS, true)).toEqual({
      kind: 'multi',
      indices: [1, 2, 3],
      labels: ['指定群聊', '指定联系人', '先查看会话列表'],
    })
  })

  it('multi-select accepts a single number', () => {
    expect(parseQuestionAnswer('2', OPTIONS, true)).toEqual({
      kind: 'multi',
      indices: [2],
      labels: ['指定联系人'],
    })
  })

  it('out-of-range numbers are invalid', () => {
    expect(parseQuestionAnswer('5', OPTIONS, false)).toEqual({ kind: 'invalid' })
    expect(parseQuestionAnswer('1,9', OPTIONS, true)).toEqual({ kind: 'invalid' })
  })

  it('empty text is invalid', () => {
    expect(parseQuestionAnswer('   ', OPTIONS, false)).toEqual({ kind: 'invalid' })
  })
})

describe('formatQuestionMessage', () => {
  it('formats a single question with options and hints', () => {
    const text = formatQuestionMessage({
      question: '要把消息发给谁？',
      header: '接收人',
      options: OPTIONS,
    })
    expect(text).toContain('📋 问题｜接收人：要把消息发给谁？')
    expect(text).toContain('[1] 指定群聊 — 告诉我群名或群 ID')
    expect(text).toContain('[2] 指定联系人 — 告诉我联系人姓名或 open_id')
    expect(text).toContain('[3] 先查看会话列表 — 我先拉取你的会话列表')
    expect(text).toContain('回复数字选择；直接输入文字 = 自定义答案；回复 0 = 取消')
  })

  it('shows question position for multi-question questionnaires', () => {
    const text = formatQuestionMessage({
      question: 'Q1?',
      options: OPTIONS,
      index: 1,
      total: 3,
    })
    expect(text).toContain('📋 问题 1/3：Q1?')
  })

  it('shows multi-select hint', () => {
    const text = formatQuestionMessage({
      question: '选哪些？',
      options: OPTIONS,
      multiSelect: true,
    })
    expect(text).toContain('（多选）')
    expect(text).toContain('回复多个数字选择（如 1,3）')
  })

  it('truncates long descriptions', () => {
    const long = 'x'.repeat(200)
    const text = formatQuestionMessage({
      question: 'q?',
      options: [{ label: 'A', description: long }],
    })
    expect(text).toContain(`[1] A — ${'x'.repeat(79)}…`)
  })
})

describe('getQuestionTimeoutMs', () => {
  afterEach(() => {
    delete process.env.PI_WECHAT_QUESTION_TIMEOUT_MS
  })

  it('returns default when no env', () => {
    expect(getQuestionTimeoutMs()).toBe(DEFAULT_QUESTION_TIMEOUT_MS)
  })

  it('respects env override', () => {
    process.env.PI_WECHAT_QUESTION_TIMEOUT_MS = '30000'
    expect(getQuestionTimeoutMs()).toBe(30000)
  })

  it('falls back to default for invalid env', () => {
    process.env.PI_WECHAT_QUESTION_TIMEOUT_MS = '-5'
    expect(getQuestionTimeoutMs()).toBe(DEFAULT_QUESTION_TIMEOUT_MS)
  })
})

describe('MessageQueue — pending question flow', () => {
  let mockSendText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSendText = vi.fn().mockResolvedValue(undefined)
  })

  it('askQuestion sends the formatted question and resolves on answer', async () => {
    const { queue, client } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })

    const promise = queue.askQuestion({
      userId: 'user_1',
      question: '要把消息发给谁？',
      options: OPTIONS,
    })

    // 等待消息发送（microtask）
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledTimes(1))
    const sent = mockSendText.mock.calls[0]
    expect(sent[0]).toBe('user_1')
    expect(sent[1]).toContain('[2] 指定联系人')
    expect(queue.pendingQuestionUserId).toBe('user_1')

    // 用户回复数字 → 解析为选项
    const consumed = queue.answerPendingQuestion('user_1', '2')
    expect(consumed).toBe(true)
    const answer = await promise
    expect(answer).toEqual({ kind: 'option', index: 2, label: '指定联系人' })
    expect(queue.pendingQuestionUserId).toBeNull()
  })

  it('answer from another user is not consumed', async () => {
    const { queue, client } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })
    const promise = queue.askQuestion({
      userId: 'user_1',
      question: 'q?',
      options: OPTIONS,
    })
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledTimes(1))

    expect(queue.answerPendingQuestion('user_2', '1')).toBe(false)
    await vi.waitFor(() => expect(queue.pendingQuestionUserId).toBe('user_1'))

    // 正确用户回复
    queue.answerPendingQuestion('user_1', '1')
    const answer = await promise
    expect(answer).toEqual({ kind: 'option', index: 1, label: '指定群聊' })
  })

  it('invalid answer keeps waiting and prompts again', async () => {
    const { queue, client } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })
    const promise = queue.askQuestion({
      userId: 'user_1',
      question: 'q?',
      options: OPTIONS,
    })
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledTimes(1))

    const consumed = queue.answerPendingQuestion('user_1', '99')
    expect(consumed).toBe(true)
    // 仍在等待
    expect(queue.pendingQuestionUserId).toBe('user_1')
    // 提示重发消息已发送
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledTimes(2))

    queue.answerPendingQuestion('user_1', '3')
    const answer = await promise
    expect(answer).toEqual({ kind: 'option', index: 3, label: '先查看会话列表' })
  })

  it('cancel answer resolves with chat', async () => {
    const { queue, client } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })
    const promise = queue.askQuestion({
      userId: 'user_1',
      question: 'q?',
      options: OPTIONS,
    })
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledTimes(1))

    queue.answerPendingQuestion('user_1', '0')
    const answer = await promise
    expect(answer).toEqual({ kind: 'cancel' })
    expect(queue.pendingQuestionUserId).toBeNull()
  })

  it('timeout resolves null and clears pending', async () => {
    vi.useFakeTimers()
    const { queue, client } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })
    const promise = queue.askQuestion({
      userId: 'user_1',
      question: 'q?',
      options: OPTIONS,
      timeoutMs: 1000,
    })
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledTimes(1))

    vi.advanceTimersByTime(1001)
    const answer = await promise
    expect(answer).toBeNull()
    expect(queue.pendingQuestionUserId).toBeNull()
    vi.useRealTimers()
  })

  it('abort signal resolves null', async () => {
    const { queue, client } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })
    const controller = new AbortController()
    const promise = queue.askQuestion({
      userId: 'user_1',
      question: 'q?',
      options: OPTIONS,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledTimes(1))

    controller.abort()
    const answer = await promise
    expect(answer).toBeNull()
    expect(queue.pendingQuestionUserId).toBeNull()
  })

  it('not running → resolves null immediately', async () => {
    const { queue } = makeQueue({ running: false })
    const answer = await queue.askQuestion({
      userId: 'user_1',
      question: 'q?',
      options: OPTIONS,
    })
    expect(answer).toBeNull()
  })

  it('send failure resolves null', async () => {
    const failSend = vi.fn().mockRejectedValue(new Error('no context token'))
    const { queue } = makeQueue({
      client: vi.fn(() => ({ sendText: failSend })),
    })
    const answer = await queue.askQuestion({
      userId: 'user_1',
      question: 'q?',
      options: OPTIONS,
    })
    expect(answer).toBeNull()
  })

  it('reset cancels the pending question', async () => {
    const { queue, client } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })
    const promise = queue.askQuestion({
      userId: 'user_1',
      question: 'q?',
      options: OPTIONS,
    })
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledTimes(1))

    queue.reset()
    const answer = await promise
    expect(answer).toBeNull()
    expect(queue.pendingQuestionUserId).toBeNull()
  })

  it('multi-select answer resolves with selected labels', async () => {
    const { queue, client } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })
    const promise = queue.askQuestion({
      userId: 'user_1',
      question: '选哪些？',
      options: OPTIONS,
      multiSelect: true,
    })
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledTimes(1))
    expect(mockSendText.mock.calls[0][1]).toContain('回复多个数字选择')

    queue.answerPendingQuestion('user_1', '1,3')
    const answer = await promise
    expect(answer).toEqual({
      kind: 'multi',
      indices: [1, 3],
      labels: ['指定群聊', '先查看会话列表'],
    })
  })
})
