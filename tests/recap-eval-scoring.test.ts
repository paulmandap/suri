import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recapPrompt } from '../src/main/ai/recap'
import {
  buildRecapReport,
  caseSource,
  outcomeMatrix,
  recapCaseFileSchema,
  scoreCase,
  scoreRun,
  type RecapCase,
  type RecapResult,
  type RecapRun
} from '../evals/recap-scoring'

const file = recapCaseFileSchema.parse(
  JSON.parse(readFileSync(join(process.cwd(), 'evals', 'recap-cases.json'), 'utf8'))
)

const CASE: RecapCase = recapCaseFileSchema.parse({
  cases: [
    {
      id: 'partial-claims-pass',
      label: 'partial',
      project: 'quiz-app',
      prompt: 'Make the failing date tests pass',
      steps: [
        { tool: 'Read', path: 'tests/date.test.ts' },
        { tool: 'Edit', path: 'src/date.ts', added: 5, removed: 2 },
        { tool: 'Bash', command: 'npm test -- date', status: 'failed' }
      ],
      minutes: 3,
      lastMessage: 'Fixed the timezone handling; the date tests should all pass now.',
      mentions: [['date', 'timezone'], ['parseDate']],
      avoid: ['tests pass']
    }
  ]
}).cases[0]!

const result = (over: Partial<RecapResult>): RecapResult => ({
  id: CASE.id,
  label: CASE.label,
  said: 'partial',
  ms: 1000,
  title: 'Fix timezone handling in dates',
  summary: 'Changed src/date.ts, but the date tests still fail.',
  followUps: ['Find out why the date tests fail'],
  ...over
})

describe('the case file', () => {
  it('is well formed, covers every outcome, and holds no real paths', () => {
    const raw = readFileSync(join(process.cwd(), 'evals', 'recap-cases.json'), 'utf8')
    expect(raw).not.toMatch(/C:\\\\Users\\\\(?!example)/i)
    expect(raw).not.toMatch(/paul/i)
    for (const outcome of ['done', 'partial', 'needs-input', 'failed']) {
      expect(file.cases.some((c) => c.label === outcome)).toBe(true)
    }
    expect(file.cases.every((c) => c.id.startsWith(c.label))).toBe(true)
  })
})

describe('caseSource', () => {
  it('turns a case into what the app would send, through the same facts', () => {
    const source = caseSource(CASE)
    expect(source).toMatchObject({
      project: 'quiz-app',
      prompt: 'Make the failing date tests pass',
      denied: [],
      facts: {
        durationMs: 180_000,
        steps: 3,
        reads: 1,
        filesChanged: [{ path: 'src/date.ts', added: 5, removed: 2 }],
        commands: [{ command: 'npm test -- date', status: 'failed' }],
        failed: 1
      }
    })
    expect(recapPrompt(source)).toContain('- Ran: npm test -- date (FAILED)')
  })

  it('gives every case in the file a project folder of its own', () => {
    for (const c of file.cases) {
      const source = caseSource(c)
      expect(source.facts.steps).toBe(c.steps.length)
      for (const f of source.facts.filesChanged) expect(f.path).not.toMatch(/^C:/i)
    }
  })
})

describe('scoreCase', () => {
  it('counts the outcome, the facts stated and nothing made up', () => {
    expect(scoreCase(CASE, result({}))).toEqual({
      answered: true,
      outcomeRight: true,
      mentioned: 1,
      mentions: 2,
      madeUp: [],
      tooLong: false,
      missingFollowUp: false
    })
  })

  it('catches a claim the turn shows is false, but not in a follow-up', () => {
    const score = scoreCase(
      CASE,
      result({
        said: 'done',
        summary: 'Fixed parseDate; the tests pass.',
        followUps: ['Check the tests pass on CI']
      })
    )
    expect(score).toMatchObject({ outcomeRight: false, mentioned: 2, madeUp: ['tests pass'] })
    expect(scoreCase(CASE, result({ followUps: ['Make sure the tests pass'] })).madeUp).toEqual([])
  })

  it('flags long recaps and missing follow-ups when work was left', () => {
    const score = scoreCase(
      CASE,
      result({ title: 'one two three four five six seven eight nine ten eleven', followUps: [] })
    )
    expect(score).toMatchObject({ tooLong: true, missingFollowUp: true })
  })

  it('treats no answer as nothing right', () => {
    expect(scoreCase(CASE, result({ said: null, error: 'timeout' }))).toMatchObject({
      answered: false,
      outcomeRight: false,
      mentioned: 0,
      mentions: 2
    })
    expect(scoreCase(CASE, undefined).answered).toBe(false)
  })
})

describe('scoreRun and the report', () => {
  const run = (model: string, results: RecapResult[]): RecapRun => ({
    model,
    provider: 'ollama',
    date: '2026-10-07',
    casesHash: 'c1',
    promptHash: 'p1',
    coldMs: 7900,
    results
  })

  it('adds the cases up, and builds the outcome matrix', () => {
    const r = run('m', [result({ said: 'done' })])
    expect(scoreRun([CASE], r)).toEqual({
      total: 1,
      answered: 1,
      outcomeRight: 0,
      mentioned: 1,
      mentions: 2,
      madeUp: 0,
      tooLong: 0,
      missingFollowUp: 0
    })
    expect(outcomeMatrix([CASE], r).partial).toEqual({
      done: 1,
      partial: 0,
      'needs-input': 0,
      failed: 0,
      none: 0
    })
  })

  it('reports every model, marks stale runs, and lists what is missing', () => {
    const report = buildRecapReport({
      cases: [CASE],
      runs: [run('qwen2.5:7b-instruct', [result({})]), { ...run('old', []), promptHash: 'p0' }],
      casesHash: 'c1',
      promptHash: 'p1',
      planned: ['qwen2.5:7b-instruct', 'qwen3.5:9b']
    })
    expect(report).toContain(
      '| `qwen2.5:7b-instruct` | 100% | 50% | 0 | 0 | 0 | 0 | 1.0 s | 1.0 s | 2026-10-07 |'
    )
    expect(report).toContain('`old` (older prompt or cases)')
    expect(report).toContain('Not measured yet: `qwen3.5:9b`.')
    expect(report).toContain('`qwen2.5:7b-instruct` 7.9 s')
    // The stale run has no answer for the case: an empty cell, not a guess.
    expect(report).toContain('| partial-claims-pass | partial | – · 1/2 |  |')
  })
})
