// ============================================================================
// 测试: message.ts — Markdown 分段 + 语法过滤
// ============================================================================

import { describe, it, expect } from 'vitest'
import { splitAndFilterMarkdown } from '../../src/messaging/message.js'

describe('splitAndFilterMarkdown', () => {
  it('returns plain text as single chunk', () => {
    const result = splitAndFilterMarkdown('hello world')
    expect(result).toEqual(['hello world'])
  })

  it('splits on headings (but merges short sections by design)', () => {
    const input = 'Intro text\n## Section 1\nContent 1\n### Sub\nContent 2'
    const result = splitAndFilterMarkdown(input)
    // short sections get merged (MIN_CHUNK_SIZE=100)
    expect(result.length).toBe(1)
    expect(result[0]).toContain('Intro text')
    expect(result[0]).toContain('Section 1')
    expect(result[0]).toContain('Sub')
  })

  it('strips heading # prefixes, keeps text', () => {
    const input = '# Title\nBody text'
    const result = splitAndFilterMarkdown(input)
    expect(result).toEqual(['Title\nBody text'])
  })

  it('splits on horizontal rules (merged when short)', () => {
    const input = 'Before\n---\nAfter'
    // Both sections < 100 chars → merged
    const result = splitAndFilterMarkdown(input)
    expect(result.length).toBe(1)
    expect(result[0]).toContain('Before')
    expect(result[0]).toContain('After')
  })

  it('filters bold syntax', () => {
    expect(splitAndFilterMarkdown('**bold** text')).toEqual(['bold text'])
  })

  it('filters italic syntax', () => {
    expect(splitAndFilterMarkdown('*italic* text')).toEqual(['italic text'])
  })

  it('filters inline code', () => {
    expect(splitAndFilterMarkdown('`code` here')).toEqual(['code here'])
  })

  it('sends code separately from the surrounding prose', () => {
    const input = 'Before\n```\ncode block\n```\nAfter'
    const result = splitAndFilterMarkdown(input)
    expect(result).toEqual(['Before', '代码 (1/1)\ncode block\n', 'After'])
  })

  it('keeps link labels and the complete destination', () => {
    expect(splitAndFilterMarkdown('[click here](https://example.com)')).toEqual(['click here: https://example.com'])
  })

  it('supports titled links and autolinks without retaining their Markdown wrapper', () => {
    expect(splitAndFilterMarkdown('[文档](https://example.com/a_b "标题") 和 <https://example.com/x>'))
      .toEqual(['文档: https://example.com/a_b 和 https://example.com/x'])
    expect(splitAndFilterMarkdown('[文档](<https://example.com/a_b>)'))
      .toEqual(['文档: https://example.com/a_b'])
  })

  it('strips underscore emphasis and thematic rules without altering identifiers', () => {
    expect(splitAndFilterMarkdown('__结论__ 和 _斜体_ 与 some_name\n***\n下一段'))
      .toEqual(['结论 和 斜体 与 some_name\n\n下一段'])
  })

  it('converts unordered lists to bullets', () => {
    const input = '- item 1\n- item 2'
    const result = splitAndFilterMarkdown(input)
    expect(result).toEqual(['• item 1\n• item 2'])
  })

  it('converts ordered lists', () => {
    const input = '1. first\n2. second'
    const result = splitAndFilterMarkdown(input)
    expect(result[0]).toBe('1. first\n2. second')
  })

  it('merges short sections', () => {
    const input = '# A\nshort\n## B\nalso short'
    // all sections < 100 chars, should merge
    const result = splitAndFilterMarkdown(input)
    // With the merge logic, short sections get merged
    expect(result.length).toBe(1)
  })

  it('splits long sections at newlines', () => {
    const longLine = 'x'.repeat(90) + '\n'
    const input = longLine.repeat(10)
    const result = splitAndFilterMarkdown(input)
    // 10 lines of 90 chars + newline = 910 chars, should split into at least 2
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(800)
    }
  })

  it('handles empty input', () => {
    expect(splitAndFilterMarkdown('')).toEqual([])
  })

  it('handles whitespace-only input', () => {
    expect(splitAndFilterMarkdown('   \n  \n ')).toEqual([])
  })

  it('handles mixed bold and italic', () => {
    expect(splitAndFilterMarkdown('**bold** and *italic*')).toEqual(['bold and italic'])
  })

  it('handles multiple horizontal rule styles (merged when short)', () => {
    const input = 'A\n***\nB\n___\nC'
    const result = splitAndFilterMarkdown(input)
    // short sections merged
    expect(result.length).toBe(1)
    expect(result[0]).toContain('A')
    expect(result[0]).toContain('B')
    expect(result[0]).toContain('C')
  })

  it('preserves code whitespace and Markdown-looking syntax across multiple chunks', () => {
    const code = '  # heading\n\n    value = "**bold** *italic* [url](https://example.com/a_b)"\n'.repeat(24)
    const chunks = splitAndFilterMarkdown('```python\n' + code + '```')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 800 && chunk.startsWith('代码 (python)'))).toBe(true)
    expect(chunks.map(chunk => chunk.slice(chunk.indexOf('\n') + 1)).join('')).toBe(code)
  })

  it('preserves a long code line, CRLF, and Unicode when its blocks are reassembled', () => {
    const code = '  ' + '👩🏽‍💻e\u0301'.repeat(160) + '\r\n  end\r\n'
    const chunks = splitAndFilterMarkdown('~~~js\r\n' + code + '~~~')
    const parts = chunks.map(chunk => chunk.slice(chunk.indexOf('\n') + 1))
    expect(parts.join('')).toBe(code)
    for (const part of parts) expect(part.replaceAll('👩🏽‍💻e\u0301', '').replace(/\s|end/g, '')).toBe('')
  })

  it('supports nested fences and an unfinished streaming code block', () => {
    expect(splitAndFilterMarkdown('````markdown\n```python\n# x\n```\n````'))
      .toEqual(['代码 (markdown) (1/1)\n```python\n# x\n```\n'])
    expect(splitAndFilterMarkdown('```js\n  const x = "**";'))
      .toEqual(['代码 (js) (1/1)\n  const x = "**";'])
  })

  it('protects literal Markdown and URLs in inline code', () => {
    expect(splitAndFilterMarkdown('`a_b **x** | [x](y)` 和 https://example.com/a_b?q=**x**'))
      .toEqual(['a_b **x** | [x](y) 和 https://example.com/a_b?q=**x**'])
    expect(splitAndFilterMarkdown('[文档](https://example.com/a_(b)?q=a_b)'))
      .toEqual(['文档: https://example.com/a_(b)?q=a_b'])
  })

  it('keeps an indivisible long URL whole and splits prose around it', () => {
    const url = 'https://example.com/' + 'a'.repeat(900)
    const chunks = splitAndFilterMarkdown('开始 ' + url + ' 结束')
    expect(chunks).toEqual(['开始', url, '结束'])
  })

  it('splits prose without breaking emoji or combining sequences', () => {
    const input = '👨‍👩‍👧‍👦e\u0301🇨🇳'.repeat(180)
    const chunks = splitAndFilterMarkdown(input)
    expect(chunks.join('')).toBe(input)
    for (const chunk of chunks) expect(chunk.replaceAll('👨‍👩‍👧‍👦', '').replaceAll('e\u0301', '').replaceAll('🇨🇳', '')).toBe('')
  })

  it('converts a table into labelled rows while preserving inline code and links', () => {
    const table = '| 名称 | 内容 |\n| --- | --- |\n| 第一项 | `a|b` |\n| 第二项 | [文档](https://example.com/a_b) |'
    expect(splitAndFilterMarkdown(table)).toEqual([
      '名称: 第一项\n内容: a|b\n\n名称: 第二项\n内容: 文档: https://example.com/a_b',
    ])
  })

  it('preserves escaped pipes in table cells', () => {
    expect(splitAndFilterMarkdown('| 名称 | 内容 |\n| --- | --- |\n| 规则 | a\\|b |'))
      .toEqual(['名称: 规则\n内容: a|b'])
  })
})
