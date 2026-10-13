import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { WechatPrompt } from '../src/wechat-prompt.js'
import { markWechatSource, WECHAT_SOURCE_TAG } from '../src/wechat-source.js'

describe('WeChat reply template', () => {
  let directory: string
  let prompt: WechatPrompt
  beforeEach(async () => {
    const scratch = path.join(process.cwd(), 'node_modules', '.cache')
    await fs.mkdir(scratch, { recursive: true })
    directory = await fs.mkdtemp(path.join(scratch, 'wechat-prompt-test-'))
    prompt = new WechatPrompt(path.join(directory, 'wechat-prompt.md'))
  })
  afterEach(async () => {
    if (!path.resolve(directory).startsWith(path.resolve(process.cwd()) + path.sep)) throw new Error('Invalid scratch directory')
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('loads the packaged default without creating a user override', async () => {
    expect(prompt.rules).toBeNull()
    await prompt.load()
    expect(prompt.source).toBe('内置模板')
    expect(prompt.rules).toContain('直接用正文提问')
    expect(prompt.rules).toContain('后续电脑端')
    await expect(fs.stat(prompt.userPath)).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('snapshots rules into new messages without changing history on reload', async () => {
    await fs.writeFile(prompt.userPath, '\uFEFF先给简短结论。')
    await prompt.load()
    const oldMessage = markWechatSource('用户原文', prompt.rules)
    await fs.writeFile(prompt.userPath, '先给详细步骤。')
    await prompt.load()
    expect(prompt.source).toBe('用户模板')
    expect(markWechatSource('用户原文', prompt.rules)).toContain('先给详细步骤。')
    expect(oldMessage).toContain('先给简短结论。')
    expect(oldMessage).not.toContain('先给详细步骤。')
    prompt.clear()
    expect(prompt.rules).toBeNull()
  })

  it('exports the default once and never overwrites a user template', async () => {
    await prompt.init()
    expect(await fs.readFile(prompt.userPath, 'utf8')).toContain('当前这条消息来自微信')
    await fs.writeFile(prompt.userPath, '我的约定')
    await expect(prompt.init()).rejects.toHaveProperty('code', 'EEXIST')
    expect(await fs.readFile(prompt.userPath, 'utf8')).toBe('我的约定')
  })

  it('retains the last good template if reload fails', async () => {
    await prompt.load()
    const previous = prompt.rules
    await fs.mkdir(prompt.userPath)
    await expect(prompt.load()).rejects.toThrow()
    expect(prompt.rules).toBe(previous)
  })
})

describe('WeChat source prefix', () => {
  it('adds one marker to a multimodal batch without changing its original parts', () => {
    const parts = [
      { type: 'text' as const, text: '看一下这张图片\n  原文缩进' },
      { type: 'image' as const, data: 'image-data', mimeType: 'image/png' },
      { type: 'text' as const, text: '再补充一句' },
    ]
    const original = structuredClone(parts)
    const marked = markWechatSource(parts, '回复约定')
    expect(parts).toEqual(original)
    expect(JSON.stringify(marked).split(WECHAT_SOURCE_TAG)).toHaveLength(2)
    expect(marked[0]).toMatchObject({ text: expect.stringContaining('看一下这张图片\n  原文缩进') })
    expect(marked[1]).toEqual(parts[1])
    expect(marked[2]).toEqual(parts[2])
  })

  it('handles image-only input and a custom marker', () => {
    const image = { type: 'image' as const, data: 'image-data', mimeType: 'image/png' }
    expect(markWechatSource([image])).toEqual([{ type: 'text', text: WECHAT_SOURCE_TAG }, image])
    expect(markWechatSource('你好', null, '[微信]')).toBe('[微信]\n\n你好')
  })
})
