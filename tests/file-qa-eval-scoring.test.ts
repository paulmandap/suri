import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCAL_BUDGET, chunkDocument, type LoadedDocument } from '../src/main/ai/file-qa'
import {
  buildFileQaReport,
  fileQaCaseFileSchema,
  retrievalHit,
  saysNotInDocument,
  scoreFileQaCase,
  scoreFileQaRun,
  type FileQaCase,
  type FileQaRun
} from '../evals/file-qa-scoring'

const file = fileQaCaseFileSchema.parse(
  JSON.parse(readFileSync(join(process.cwd(), 'evals', 'file-qa-cases.json'), 'utf8'))
)
const byId = (id: string): FileQaCase => file.cases.find((c) => c.id === id)!

describe('the case file and its documents', () => {
  it('names documents that exist, and each answerable fact is really in its document', () => {
    for (const c of file.cases) {
      const text = readFileSync(
        join(process.cwd(), 'evals', 'documents', file.documents[c.doc]!),
        'utf8'
      ).toLowerCase()
      for (const alternatives of c.mentions) {
        expect(
          alternatives.some((way) => text.includes(way.toLowerCase())),
          `${c.id}`
        ).toBe(true)
      }
    }
  })
})

describe('scoring answers', () => {
  it('counts the facts an answer states, ignoring case', () => {
    expect(scoreFileQaCase(byId('why-node-sqlite'), 'better-sqlite3 is a NATIVE module.')).toEqual({
      answered: true,
      mentioned: 1,
      mentions: 2,
      saidNotInDocument: false
    })
  })

  it('knows when an answer says the document doesn’t tell', () => {
    expect(saysNotInDocument('The document doesn’t say what Suri costs.')).toBe(true)
    expect(saysNotInDocument('It is not mentioned anywhere.')).toBe(true)
    expect(saysNotInDocument('Suri costs $5 a month.')).toBe(false)
    expect(scoreFileQaCase(byId('price'), 'Suri costs $5 a month.').saidNotInDocument).toBe(false)
  })

  it('adds up a run, with no answer as nothing stated', () => {
    const cases = [byId('port'), byId('price')]
    const s = scoreFileQaRun(cases, (c) =>
      c.id === 'port' ? 'Port 47821.' : "The file doesn't say."
    )
    expect(s).toEqual({
      cases: 2,
      answered: 2,
      mentioned: 1,
      mentions: 1,
      unanswerable: 1,
      saidNotInDocument: 1
    })
    expect(scoreFileQaRun(cases, () => null).answered).toBe(0)
  })
})

describe('retrievalHit', () => {
  const doc: LoadedDocument = {
    name: 'guide.md',
    kind: 'text',
    text: Array.from({ length: 30 }, (_, i) =>
      i === 20
        ? 'The hook server listens on port 47821.'
        : `Other topic ${i} ${'filler '.repeat(60)}`
    ).join('\n\n'),
    pages: null,
    truncated: false
  }

  it('checks that the picked chunks hold every fact the answer needs', () => {
    const c: FileQaCase = {
      id: 'x',
      doc: 'd',
      question: 'Which port does the hook server listen on?',
      mentions: [['47821']],
      answerable: true
    }
    expect(retrievalHit(c, chunkDocument(doc), LOCAL_BUDGET)).toBe(true)
    expect(retrievalHit({ ...c, mentions: [['nowhere']] }, chunkDocument(doc), LOCAL_BUDGET)).toBe(
      false
    )
  })
})

describe('the report', () => {
  it('shows retrieval, each model, and every question', () => {
    const cases = [byId('port'), byId('price')]
    const run: FileQaRun = {
      model: 'qwen3.5:9b',
      provider: 'ollama',
      date: '2026-10-07',
      casesHash: 'c',
      promptHash: 'p',
      results: [
        { id: 'port', ms: 3000, answer: '47821' },
        { id: 'price', ms: 2000, answer: '$5' }
      ]
    }
    const report = buildFileQaReport({
      cases,
      runs: [run],
      retrieval: { hits: 6, of: 7, missed: ['risk-model'] },
      casesHash: 'c',
      promptHash: 'p',
      planned: ['qwen3.5:9b']
    })
    expect(report).toContain('for 6 of 7 answerable questions')
    expect(report).toContain('(missed: risk-model)')
    expect(report).toContain('| `qwen3.5:9b` | 100% | 0/1 | 0 | 2.0 s | 2026-10-07 |')
    expect(report).toContain('| price | GUESSED |')
  })
})
