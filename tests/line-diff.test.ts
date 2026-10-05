import { describe, expect, it } from 'vitest'
import { diffLines, splitLines } from '@shared/line-diff'

const lines = (count: number, prefix = 'line'): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`)

describe('splitLines', () => {
  it('ignores a BOM, CRLF and the final newline', () => {
    expect(splitLines('﻿a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
  })
})

describe('diffLines', () => {
  it('returns no lines when nothing changes', () => {
    expect(diffLines('a\nb\n', 'a\r\nb\r\n')).toEqual({ lines: [], added: 0, removed: 0 })
  })

  it('shows an insert with three lines of context and folds the rest', () => {
    const before = lines(20)
    const after = [...before.slice(0, 10), 'new A', 'new B', ...before.slice(10)]
    const diff = diffLines(before.join('\n'), after.join('\n'))
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(0)
    expect(diff.lines).toEqual([
      { kind: 'gap', count: 7 },
      { kind: 'same', text: 'line 8', line: 8 },
      { kind: 'same', text: 'line 9', line: 9 },
      { kind: 'same', text: 'line 10', line: 10 },
      { kind: 'add', text: 'new A', line: 11 },
      { kind: 'add', text: 'new B', line: 12 },
      { kind: 'same', text: 'line 11', line: 13 },
      { kind: 'same', text: 'line 12', line: 14 },
      { kind: 'same', text: 'line 13', line: 15 },
      { kind: 'gap', count: 7 }
    ])
  })

  it('shows a changed line as a delete followed by an add', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    expect(diff.lines).toEqual([
      { kind: 'same', text: 'a', line: 1 },
      { kind: 'del', text: 'b', line: 2 },
      { kind: 'add', text: 'B', line: 2 },
      { kind: 'same', text: 'c', line: 3 }
    ])
  })

  it('finds the common lines between several changes', () => {
    const diff = diffLines('a\nb\nc\nd\ne\n', 'a\nc\nd\nX\ne\nY\n')
    expect(diff.lines.map((l) => (l.kind === 'gap' ? 'gap' : `${l.kind}:${l.text}`))).toEqual([
      'same:a',
      'del:b',
      'same:c',
      'same:d',
      'add:X',
      'same:e',
      'add:Y'
    ])
  })

  it('treats a new file as all additions', () => {
    expect(diffLines('', '{\n}\n')).toMatchObject({ added: 2, removed: 0 })
  })

  it('falls back to "all out, all in" for inputs too big to compare line by line', () => {
    const diff = diffLines(lines(2100, 'old').join('\n'), lines(2100, 'new').join('\n'))
    expect(diff).toMatchObject({ added: 2100, removed: 2100 })
    expect(diff.lines[0]).toEqual({ kind: 'del', text: 'old 1', line: 1 })
  })
})
