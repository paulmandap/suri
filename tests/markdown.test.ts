import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from '@shared/markdown'

describe('parseMarkdown', () => {
  it('reads paragraphs, headings and lists', () => {
    expect(
      parseMarkdown('## Setup\nRun the app\nfirst.\n\n- one\n- **two**\n  wrapped\n1. a\n2) b')
    ).toEqual([
      { kind: 'heading', inline: [{ kind: 'text', text: 'Setup' }] },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Run the app first.' }] },
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'text', text: 'one' }],
          [
            { kind: 'bold', text: 'two' },
            { kind: 'text', text: ' wrapped' }
          ]
        ]
      },
      {
        kind: 'list',
        ordered: true,
        items: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]]
      }
    ])
  })

  it('keeps code blocks exactly, with their language, even while still streaming', () => {
    expect(parseMarkdown('Try:\n```powershell\nnpm  test\n  # keep\n```\nDone.')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Try:' }] },
      { kind: 'code', lang: 'powershell', text: 'npm  test\n  # keep' },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Done.' }] }
    ])
    expect(parseMarkdown('```ts\nconst a = 1')).toEqual([
      { kind: 'code', lang: 'ts', text: 'const a = 1' }
    ])
  })

  it('never turns text into markup', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)> and [link](javascript:x)')
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        inline: [{ kind: 'text', text: '<img src=x onerror=alert(1)> and [link](javascript:x)' }]
      }
    ])
  })
})

describe('parseInline', () => {
  it('finds inline code and bold, and leaves lone markers alone', () => {
    expect(parseInline('Use `npm ci`, **not** install * or `')).toEqual([
      { kind: 'text', text: 'Use ' },
      { kind: 'code', text: 'npm ci' },
      { kind: 'text', text: ', ' },
      { kind: 'bold', text: 'not' },
      { kind: 'text', text: ' install * or `' }
    ])
  })
})
