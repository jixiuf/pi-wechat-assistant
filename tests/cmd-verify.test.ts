import { describe, it, expect } from 'vitest'
import { handleRemoteCommand } from '../src/remote-commands.js'

// 验证命令注册与解析（用 mock deps，只测命令表是否存在 + 参数解析）
describe('微信命令注册验证', () => {
  const mockDeps: any = {
    pi: { sendUserMessage: async () => {} },
    getCtx: () => null, // 触发 '❌ 会话上下文尚未就绪' 分支（证明命令被识别）
    client: () => null,
    queueLength: () => 0,
  }
  const mockClient: any = { sendText: async () => {} }

  const cases: Array<[string, boolean]> = [
    ['/new', true],
    ['/prev', true],
    ['/next', true],
    ['/sessions', true],
    ['/goto 2', true],
    ['/reload-all', true],
    ['/status', true],
    ['/unknown-xyz', false],
  ]

  it.each(cases)('命令 %s 识别=%s', async (text, expected) => {
    const result = await handleRemoteCommand(text, 'user', mockClient, mockDeps)
    // 命令被识别 → 返回 true（即使 ctx 未就绪返回错误文本）
    expect(result).toBe(expected)
  })
})
