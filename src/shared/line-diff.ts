// A small line diff for the hook installer's preview: Paul sees exactly which
// lines of Claude Code's settings.json change before he clicks. Settings files
// are short, so a plain LCS over the changed middle is plenty.

/** `line` is the line number in the new text (`same`, `add`) or the old one (`del`). */
export type DiffLine =
  { kind: 'same' | 'add' | 'del'; text: string; line: number } | { kind: 'gap'; count: number }

export interface LineDiff {
  /** Changed lines with a few lines of context; empty when nothing changes. */
  lines: DiffLine[]
  added: number
  removed: number
}

type Op = { kind: 'same' | 'add' | 'del'; text: string }

/** Past this many table cells, show "all out, all in" rather than use a lot of memory. */
const MAX_CELLS = 4_000_000

export function diffLines(before: string, after: string, context = 3): LineDiff {
  const ops = diffOps(splitLines(before), splitLines(after))
  const added = ops.filter((op) => op.kind === 'add').length
  const removed = ops.filter((op) => op.kind === 'del').length
  if (added === 0 && removed === 0) return { lines: [], added, removed }
  return { lines: withContext(numbered(ops), context), added, removed }
}

/** Lines of a text file, ignoring a BOM, CRLF vs LF, and the final newline. */
export function splitLines(text: string): string[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text
  if (body === '') return []
  const lines = body.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function diffOps(a: string[], b: string[]): Op[] {
  // Most of a settings file doesn't change: trim the shared start and end first.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const same = (text: string): Op => ({ kind: 'same', text })
  return [
    ...a.slice(0, start).map(same),
    ...middle(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map(same)
  ]
}

function middle(a: string[], b: string[]): Op[] {
  const del = (text: string): Op => ({ kind: 'del', text })
  const add = (text: string): Op => ({ kind: 'add', text })
  const n = a.length
  const m = b.length
  if ((n + 1) * (m + 1) > MAX_CELLS) return [...a.map(del), ...b.map(add)]

  // lcs[i * w + j] = length of the longest common subsequence of a[i..] and b[j..].
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      ops.push(del(a[i++]))
    } else {
      ops.push(add(b[j++]))
    }
  }
  while (i < n) ops.push(del(a[i++]))
  while (j < m) ops.push(add(b[j++]))
  return ops
}

function numbered(ops: Op[]): Exclude<DiffLine, { kind: 'gap' }>[] {
  let oldLine = 0
  let newLine = 0
  return ops.map((op) => {
    if (op.kind === 'del') return { ...op, line: ++oldLine }
    oldLine += op.kind === 'same' ? 1 : 0
    return { ...op, line: ++newLine }
  })
}

/** Keeps `context` unchanged lines around each change and folds the rest into gaps. */
function withContext(lines: Exclude<DiffLine, { kind: 'gap' }>[], context: number): DiffLine[] {
  const keep = lines.map(() => false)
  lines.forEach((line, k) => {
    if (line.kind === 'same') return
    for (let d = Math.max(0, k - context); d <= Math.min(lines.length - 1, k + context); d++) {
      keep[d] = true
    }
  })
  const out: DiffLine[] = []
  let skipped = 0
  lines.forEach((line, k) => {
    if (!keep[k]) {
      skipped++
      return
    }
    if (skipped > 0) out.push({ kind: 'gap', count: skipped })
    skipped = 0
    out.push(line)
  })
  if (skipped > 0) out.push({ kind: 'gap', count: skipped })
  return out
}
