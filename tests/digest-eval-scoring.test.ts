import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { digestMarkdown, plainDigest, type Digest } from '@shared/digest'
import { digestPrompt } from '../src/main/ai/digest'
import {
  buildDigestReport,
  caseFacts,
  digestCaseFileSchema,
  scoreDigestCase,
  scoreDigestRun,
  type DigestCase,
  type DigestRun
} from '../evals/digest-scoring'

const raw = readFileSync(join(process.cwd(), 'evals', 'digest-cases.json'), 'utf8')
const file = digestCaseFileSchema.parse(JSON.parse(raw))
const day = (id: string): DigestCase => file.cases.find((c) => c.id === id)!
const plain = (c: DigestCase): Digest => plainDigest(caseFacts(c), 0)

describe('the case file', () => {
  it('is well formed, with made-up projects only', () => {
    expect(raw).not.toMatch(/paul|C:\\\\Users/i)
    for (const c of file.cases) {
      const projects = new Set(c.turns.map((t) => t.project))
      for (const item of c.expect) expect(projects.has(item.project)).toBe(true)
    }
  })

  it("is placed right by Suri's own plain notes, so every expectation can be met", () => {
    for (const c of file.cases) {
      expect(scoreDigestCase(c, plain(c))).toMatchObject({
        placed: c.expect.length,
        claimedDone: 0,
        missing: 0
      })
    }
  })

  it('fits the prompt budget', () => {
    for (const c of file.cases) expect(digestPrompt(caseFacts(c)).length).toBeLessThan(8000)
  })
})

describe('caseFacts', () => {
  it("turns a day into the app's facts, approvals included", () => {
    const facts = caseFacts(day('failures-and-questions'))
    expect(facts.turns).toBe(4)
    expect(facts.projects.map((p) => p.name)).toEqual(['desktop-app', 'shop-backend'])
    expect(facts.approvals).toEqual({ allowed: 1, denied: 1 })
    expect(facts.projects[0]!.items[1]).toMatchObject({
      title: 'Fix the native build',
      outcome: 'failed'
    })
  })
})

describe('scoreDigestCase', () => {
  const c = day('two-projects-mixed')
  const base = plain(c)

  it('counts unfinished work shown as done', () => {
    const wrong: Digest = {
      ...base,
      projects: [
        {
          name: 'notes-web',
          done: ['Added dark mode', 'Fixed the flaky login test'],
          inProgress: []
        },
        base.projects[1]!
      ]
    }
    expect(scoreDigestCase(c, wrong)).toMatchObject({ placed: 3, claimedDone: 1, missing: 0 })
  })

  it('counts work that went missing, and lists that are short', () => {
    const thin: Digest = {
      ...base,
      headline: 'A day.',
      projects: [{ name: 'notes-web', done: ['Added dark mode'], inProgress: [] }],
      blockers: [],
      next: []
    }
    expect(scoreDigestCase(c, thin)).toMatchObject({
      placed: 1,
      missing: 3,
      blockers: 0,
      next: 0
    })
  })

  it('treats no answer as nothing placed, and flags a long headline', () => {
    expect(scoreDigestCase(c, null)).toMatchObject({ answered: false, placed: 0, missing: 4 })
    const long = { ...base, headline: 'word '.repeat(31) }
    expect(scoreDigestCase(c, long).longHeadline).toBe(true)
  })
})

describe('the report', () => {
  it('starts with Suri alone, then each model, and marks stale runs', () => {
    const cases = [day('small-day')]
    const run: DigestRun = {
      model: 'qwen3.5:9b',
      provider: 'ollama',
      date: '2026-10-07',
      casesHash: 'c1',
      promptHash: 'p0',
      results: [{ id: 'small-day', ms: 2500, digest: plain(cases[0]!) }]
    }
    const report = buildDigestReport({
      cases,
      runs: [run],
      plain,
      casesHash: 'c1',
      promptHash: 'p1',
      planned: ['qwen3.5:9b', 'gemini-3.8-flash']
    })
    expect(report).toContain('| Suri alone (no model) | 100% | 0 | 0 | 0/0 | 0/0 | 0 | 0 | – | – |')
    expect(report).toContain('`qwen3.5:9b` (older prompt or cases) | 100%')
    expect(report).toContain('Not measured yet: `gemini-3.8-flash`.')
    expect(report).toContain('| small-day | 1/1 | 1/1 |')
    expect(scoreDigestRun(cases, () => null).answered).toBe(0)
    // What Paul copies is the same notes, as Markdown.
    expect(digestMarkdown(plain(cases[0]!))).toContain('## rates-sync')
  })
})
