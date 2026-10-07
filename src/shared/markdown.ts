// A small Markdown reader for the answers to file questions (ADR-027). It
// covers what models write (paragraphs, headings, lists, code blocks, inline
// code and bold) and turns it into data, which the island renders as React
// elements. No HTML is ever produced, so an answer can't inject markup. An
// unclosed code block is still a code block, since answers arrive streaming.

export type Inline =
  { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'bold'; text: string }

export type Block =
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'heading'; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; lang: string; text: string }

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/
const BULLET = /^\s{0,3}[-*•]\s+(.*)$/
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' ')) })
      paragraph = []
    }
  }
  const flushList = (): void => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(parseInline) })
      list = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)
    if (fence) {
      flushParagraph()
      flushList()
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(fence[1] ?? '```')) {
        body.push(lines[i] ?? '')
        i++
      }
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ kind: 'heading', inline: parseInline((heading[1] ?? '').trim()) })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = numbered !== null
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push(((bullet ?? numbered)?.[1] ?? '').trim())
      continue
    }
    // A wrapped line belongs to the list item above it.
    if (list && /^\s+\S/.test(line)) {
      const last = list.items.length - 1
      list.items[last] = `${list.items[last]} ${line.trim()}`
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  return blocks
}

/** `code` and **bold**; everything else is text, exactly as written. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    if (match[1] !== undefined) out.push({ kind: 'code', text: match[1] })
    else out.push({ kind: 'bold', text: match[2] ?? '' })
    last = at + match[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}
