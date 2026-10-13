// WeChat receives plain text. Protect code and URLs before formatting prose.
const DEFAULT_CHUNK_SIZE = 800
const MIN_CHUNK_SIZE = 100
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

type Block = { kind: 'text'; text: string } | { kind: 'code'; text: string; language: string }

export function splitAndFilterMarkdown(text: string, maxChunkSize = DEFAULT_CHUNK_SIZE): string[] {
  if (!Number.isFinite(maxChunkSize) || maxChunkSize < 80) throw new RangeError('Chunk size must be at least 80')
  const limit = Math.floor(maxChunkSize)
  const result: string[] = []
  for (const block of parseBlocks(text)) {
    if (block.kind === 'code') {
      const prefix = '代码' + (block.language ? ' (' + block.language + ')' : '')
      const parts = splitLongText(block.text, limit - prefix.length - 20, true)
      result.push(...parts.map((part, i) => prefix + ' (' + (i + 1) + '/' + parts.length + ')\n' + part))
    } else {
      const sections = splitSections(formatProse(block.text))
      const merged: string[] = []
      let current = ''
      for (const section of sections) {
        if (current && current.length >= MIN_CHUNK_SIZE) {
          merged.push(current)
          current = section
        } else current = current ? current + '\n\n' + section : section
      }
      if (current) merged.push(current)
      for (const section of merged) result.push(...splitLongText(section, limit, false))
    }
  }
  return result
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let plain = ''
  let code: Extract<Block, { kind: 'code' }> | null = null
  let closing: RegExp | null = null
  for (const line of text.split(/(?<=\n)/)) {
    if (code) {
      if (closing!.test(line)) {
        blocks.push(code)
        code = null
      } else code.text += line
      continue
    }
    const fence = /^ {0,3}(\u0060{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line)
    if (fence) {
      if (plain) blocks.push({ kind: 'text', text: plain })
      plain = ''
      const language = fence[2].trim().split(/\s+/)[0].replace(/[^\w.+-]/g, '').slice(0, 24)
      code = { kind: 'code', text: '', language }
      closing = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}[ \\t]*(?:\\r?\\n)?$')
    } else plain += line
  }
  if (code) blocks.push(code)
  if (plain) blocks.push({ kind: 'text', text: plain })
  return blocks
}

function formatProse(text: string): string {
  const literals: string[] = []
  const protect = (value: string): string => '\u0000' + (literals.push(value) - 1) + '\u0000'
  let formatted = text
    .replace(/(\u0060+)([\s\S]*?)\1/g, (_match, _fence, content: string) => protect(content))
    .replace(/(!?)\[([^\]\n]+)\]\(([^()\s]+(?:\([^()\n]*\)[^()\s]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)/g,
      (_match, image: string, label: string, url: string) => {
        const destination = url.replace(/^<|>$/g, '')
        if (label === destination) return protect(destination)
        return (image ? '图片 ' : '') + label + ': ' + protect(destination)
      })
    .replace(/<(https?:\/\/[^<>\s]+)>/g, (_match, url: string) => protect(url))
    .replace(/https?:\/\/[^\s\u0000<>]+/g, (url: string) => protect(url))
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(?<!\w)__(\S(?:.*?\S)?)__(?!\w)/g, '$1')
    .replace(/(?<!\w)_(\S(?:.*?\S)?)_(?!\w)/g, '$1')
    .replace(/^[-*+]\s+/gm, '• ')
  formatted = formatTables(formatted)
  return formatted.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => literals[Number(index)])
}

function formatTables(text: string): string {
  const lines = text.split('\n')
  const cells = (line: string): string[] => line.trim().replace(/^\||(?<!\\)\|$/g, '')
    .split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
  const result: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const separator = lines[i + 1]
    if (lines[i].includes('|') && separator?.includes('|') && cells(separator).every(cell => /^:?-{3,}:?$/.test(cell))) {
      const headers = cells(lines[i])
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        result.push(cells(lines[i]).map((value, index) => (headers[index] || '列 ' + (index + 1)) + ': ' + value).join('\n'), '')
        i++
      }
      i--
    } else result.push(lines[i])
  }
  return result.join('\n')
}

function splitSections(text: string): string[] {
  const result: string[] = []
  let current: string[] = []
  const flush = () => {
    const section = current.join('\n').trim()
    if (section) result.push(section)
    current = []
  }
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      flush()
      current.push(line.replace(/^#{1,6}\s+/, ''))
    } else if (!line.trim() || /^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line) || /^___+\s*$/.test(line)) flush()
    else current.push(line)
  }
  flush()
  return result
}

function safeBoundary(text: string, limit: number): number {
  let end = 0
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > limit) return end || segment.length
    end = index + segment.length
  }
  return end
}

function splitLongText(text: string, limit: number, code: boolean): string[] {
  const result: string[] = []
  let remaining = code ? text : text.trim()
  while (remaining.length > limit) {
    let cut = safeBoundary(remaining, limit)
    const newline = remaining.lastIndexOf('\n', cut - 1) + 1
    if (newline > 0 && (code || newline >= cut / 2)) cut = newline
    else if (!code) {
      const space = remaining.lastIndexOf(' ', cut - 1) + 1
      if (space >= cut / 2) cut = space
    }
    if (!code) {
      // An indivisible URL may exceed the target size; send it whole rather than break it.
      for (const match of remaining.matchAll(/https?:\/\/\S+/g)) {
        const start = match.index!
        const end = start + match[0].length
        if (start < cut && end > cut) { cut = start || end; break }
      }
    }
    const part = remaining.slice(0, cut)
    if (code || part.trim()) result.push(code ? part : part.trim())
    remaining = code ? remaining.slice(cut) : remaining.slice(cut).trim()
  }
  if (code ? remaining.length > 0 : remaining.trim().length > 0) result.push(code ? remaining : remaining.trim())
  return result
}
