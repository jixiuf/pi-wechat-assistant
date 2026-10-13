import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { WechatPrompt } from '../src/wechat-prompt.js'
import { markWechatSource, appendWechatSystemRules, WECHAT_SOURCE_TAG } from '../src/wechat-source.js'

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
    await expect(fs.stat(prompt.userPath)).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('exposes the current template for the system rules without channel boilerplate', async () => {
    await fs.writeFile(prompt.userPath, '\uFEFF先给简短结论。')
    await prompt.load()
    expect(prompt.rules).toBe('先给简短结论。')
    await fs.writeFile(prompt.userPath, '先给详细步骤。')
    await prompt.load()
    expect(prompt.rules).toBe('先给详细步骤。')
    prompt.clear()
    expect(prompt.rules).toBeNull()
  })

  it('exports the default once and never overwrites a user template', async () => {
    await prompt.init()
    expect(await fs.readFile(prompt.userPath, 'utf8')).toContain('通过微信阅读和回复')
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
    const marked = markWechatSource(parts)
    expect(parts).toEqual(original)
    expect(JSON.stringify(marked).split(WECHAT_SOURCE_TAG)).toHaveLength(2)
    expect(marked[0]).toMatchObject({ text: expect.stringContaining('看一下这张图片\n  原文缩进') })
    expect(marked[1]).toEqual(parts[1])
    expect(marked[2]).toEqual(parts[2])
  })

  it('handles image-only input and a custom marker', () => {
    const image = { type: 'image' as const, data: 'image-data', mimeType: 'image/png' }
    expect(markWechatSource([image])).toEqual([{ type: 'text', text: WECHAT_SOURCE_TAG }, image])
    expect(markWechatSource('你好', '[微信]')).toBe('[微信]\n\n你好')
  })
})

describe('WeChat system rules section', () => {
  it('appends one conditional section that names the marker and defers routing', () => {
    const result = appendWechatSystemRules('BASE', '规则A', '[微信]')
    expect(result.startsWith('BASE\n\n<wechat-system-rules>\n')).toBe(true)
    expect(result.endsWith('\n</wechat-system-rules>')).toBe(true)
    expect(result).toContain('规则A')
    expect(result).toContain(JSON.stringify('[微信]'))
    expect(result).toContain('仅在当前最新用户请求由微信桥接投递')
    expect(result).toContain('不因历史里出现过微信消息')
    expect(result).toContain('电脑端 TUI 或其他来源')
  })

  it('uses the default marker when none is given', () => {
    expect(appendWechatSystemRules('BASE', 'R')).toContain(JSON.stringify(WECHAT_SOURCE_TAG))
  })
})
