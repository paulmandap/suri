import { describe, expect, it } from 'vitest'
import type { Feature } from '@shared/ai-config'
import {
  buildDigestFacts,
  digestFromReply,
  digestMarkdown,
  plainDigest,
  statsLine,
  type DigestFacts,
  type DigestReply
} from '@shared/digest'
import type { DecisionView, Recap, TurnView } from '@shared/history'
import { DIGEST_PROMPT_BUDGET, digestPrompt, writeDigest } from '../src/main/ai/digest'
import { AIError, type JsonRequest } from '../src/main/ai/provider'
import type { AIRouter, RoutedResult } from '../src/main/ai/router'

const DAY = '2026-10-07'
let nextId = 1

function turn(over: Partial<TurnView> & { recap?: Recap }): TurnView {
  const id = nextId++
  return {
    id,
    sessionId: 's1',
    project: 'suri',
    day: DAY,
    prompt: `request ${id}`,
    status: 'done',
    startedAt: id * 1000,
    decisions: [],
    facts: {
      durationMs: 60_000,
      steps: 4,
      filesChanged: [{ path: 'a.ts', added: 3, removed: 1 }],
      moreFiles: 0,
      linesAdded: 3,
      linesRemoved: 1,
      commands: [{ command: 'npm test', status: 'ok' }],
      moreCommands: 0,
      reads: 1,
      searches: 0,
      web: 0,
      agents: 0,
      failed: 0
    },
    ...over
  }
}

const recap = (outcome: Recap['outcome'], title: string, followUps: string[] = []): Recap => ({
  title,
  summary: `${title}, in short.`,
  outcome,
  followUps,
  model: 'qwen2.5:7b-instruct'
})

const decision = (outcome: DecisionView['outcome']): DecisionView => ({
  tool: 'Bash',
  detail: 'git push',
  outcome,
  askedAt: 1,
  answeredAt: 2
})

function sampleFacts(): DigestFacts {
  return buildDigestFacts(
    DAY,
    [
      turn({ recap: recap('done', 'Add the recap writer', ['Measure recap quality']) }),
      turn({ project: 'learning_app', recap: recap('partial', 'Fix flaky quiz test') }),
      turn({ recap: recap('needs-input', 'Pick a digest format') }),
      turn({ recap: recap('failed', 'Build the installer', ['Install the MSVC tools']) }),
      turn({ prompt: 'Rename the tray items', status: 'done' }),
      turn({ prompt: 'Try the release build', status: 'error', error: 'API overloaded' }),
      // Did nothing at all: left out.
      turn({ prompt: undefined, facts: undefined }),
      turn({
        project: 'learning_app',
        recap: recap('done', 'Add bread', ['Measure recap quality'])
      })
    ],
    [decision('allow'), decision('allow'), decision('deny'), decision('timeout')]
  )
}

describe('buildDigestFacts', () => {
  it('groups turns that did something by project, in the order work started', () => {
    const facts = sampleFacts()
    expect(facts.turns).toBe(7)
    expect(facts.projects.map((p) => [p.name, p.turns])).toEqual([
      ['suri', 5],
      ['learning_app', 2]
    ])
    expect(facts.approvals).toEqual({ allowed: 2, denied: 1 })
    expect(facts).toMatchObject({ filesChanged: 7, linesAdded: 21, linesRemoved: 7 })
    expect(facts.projects[0]?.items[4]).toMatchObject({
      title: 'Try the release build',
      status: 'error',
      summary: 'API overloaded'
    })
  })
})

describe('plainDigest', () => {
  it('sorts items into done and in progress, and finds blockers and next steps', () => {
    const digest = plainDigest(sampleFacts(), 42)
    expect(digest.projects).toEqual([
      {
        name: 'suri',
        done: ['Add the recap writer', 'Rename the tray items'],
        inProgress: ['Pick a digest format', 'Build the installer', 'Try the release build']
      },
      { name: 'learning_app', done: ['Add bread'], inProgress: ['Fix flaky quiz test'] }
    ])
    expect(digest.blockers).toEqual([
      'Pick a digest format (waiting for your answer)',
      "Build the installer (couldn't finish)",
      'Try the release build (stopped with an error)'
    ])
    // The same follow-up from two turns shows once.
    expect(digest.next).toEqual(['Measure recap quality', 'Install the MSVC tools'])
    expect(digest.headline).toBe('7 turns across 2 projects: suri and learning_app.')
    expect(digest).toMatchObject({ turns: 7, createdAt: 42, day: DAY })
    expect(digest.model).toBeUndefined()
  })

  it('says so when there was no work', () => {
    const empty = buildDigestFacts(DAY, [], [])
    expect(plainDigest(empty, 1).headline).toBe('No Claude Code work recorded on this day.')
    expect(statsLine(empty)).toBe('0 turns')
  })
})

describe('digestFromReply', () => {
  const reply: DigestReply = {
    headline: '**A busy day** on Suri.',
    projects: [
      {
        name: 'SURI ',
        done: ['- Added the recap writer', 'Added the recap writer'],
        inProgress: []
      },
      { name: 'made-up project', done: ['Shipped everything'], inProgress: [] }
    ],
    blockers: ['Installer build fails'],
    next: ['Measure the recap', '', 'Measure the recap']
  }

  it('keeps to the history’s projects, and cleans what the model wrote', () => {
    const digest = digestFromReply(sampleFacts(), reply, { model: 'gemini-3.8-flash' }, 7)
    expect(digest.headline).toBe('A busy day on Suri.')
    expect(digest.projects.map((p) => p.name)).toEqual(['suri', 'learning_app'])
    expect(digest.projects[0]).toEqual({
      name: 'suri',
      done: ['Added the recap writer'],
      inProgress: []
    })
    // The model left learning_app out: the plain lists stand in for it.
    expect(digest.projects[1]?.done).toEqual(['Add bread'])
    expect(JSON.stringify(digest)).not.toContain('made-up project')
    expect(digest.blockers).toEqual(['Installer build fails'])
    expect(digest.next).toEqual(['Measure the recap'])
    expect(digest).toMatchObject({ model: 'gemini-3.8-flash', turns: 7, createdAt: 7 })
  })

  it('falls back to the plain headline when the model wrote none', () => {
    const digest = digestFromReply(sampleFacts(), { ...reply, headline: '  ' }, { model: 'm' }, 1)
    expect(digest.headline).toBe('7 turns across 2 projects: suri and learning_app.')
  })
})

describe('digestMarkdown', () => {
  it('writes standup notes with who wrote them', () => {
    const digest = digestFromReply(
      sampleFacts(),
      {
        headline: 'Good progress.',
        projects: [{ name: 'suri', done: ['Added recaps'], inProgress: ['Digest format'] }],
        blockers: [],
        next: ['Run the eval']
      },
      { model: 'qwen3.5:9b', fellBackFrom: 'rate limit' },
      1
    )
    const md = digestMarkdown(digest)
    expect(md).toContain('# Standup notes: Wednesday 7 October 2026\n\nGood progress.\n')
    expect(md).toContain('## suri\n\n**Done**\n- Added recaps\n\n**In progress**\n- Digest format')
    expect(md).toContain('## Next\n\n- Run the eval')
    expect(md).not.toContain('## Blockers')
    expect(md).toContain('7 turns · 7 files changed (+21 −7) · 3 approvals: 2 allowed, 1 denied')
    expect(md).toContain('_Written by Suri with qwen3.5:9b (Gemini: rate limit)._')
    expect(digestMarkdown(plainDigest(sampleFacts(), 1))).toContain(
      '_Written by Suri from its history, without AI._'
    )
  })
})

describe('digestPrompt', () => {
  it('tags each item with how it ended, and lists approvals', () => {
    const prompt = digestPrompt(sampleFacts())
    expect(prompt).toContain('Day: Wednesday 7 October 2026')
    expect(prompt).toContain('Project: suri (5 requests, about 5 min, 5 files changed)')
    expect(prompt).toContain('- [done] Add the recap writer\n  Add the recap writer, in short.')
    expect(prompt).toContain('  Follow-ups: Measure recap quality')
    expect(prompt).toContain('- [waiting for an answer] Pick a digest format')
    expect(prompt).toContain('- [stopped with an error] Try the release build')
    expect(prompt).toContain('Approvals: 2 allowed, 1 denied')
  })

  const day = (n: number, title: (i: number) => string): DigestFacts =>
    buildDigestFacts(
      DAY,
      Array.from({ length: n }, (_, i) =>
        turn({ recap: { ...recap('done', title(i)), summary: 'word '.repeat(60) } })
      ),
      []
    )

  it('drops the summaries first to stay within the budget', () => {
    const prompt = digestPrompt(day(60, (i) => `Task ${i}`))
    expect(prompt.length).toBeLessThanOrEqual(DIGEST_PROMPT_BUDGET)
    expect(prompt).not.toContain('word word')
    expect(prompt).toContain('Task 0\n')
    expect(prompt).not.toMatch(/left out/)
  })

  it('then keeps only the newest items', () => {
    const long = (i: number): string => `Task number ${i}, a long title about what was done today`
    const prompt = digestPrompt(day(200, long))
    expect(prompt.length).toBeLessThanOrEqual(DIGEST_PROMPT_BUDGET)
    expect(prompt).toContain(long(199))
    expect(prompt).not.toContain(`${long(0)}\n`)
    expect(prompt).toMatch(/- \(\d+ earlier requests left out\)/)
  })
})

describe('writeDigest', () => {
  function router(answer: () => DigestReply | Error): {
    router: Pick<AIRouter, 'generateJSON'>
    calls: { feature: Feature; timeoutMs?: number }[]
  } {
    const calls: { feature: Feature; timeoutMs?: number }[] = []
    return {
      calls,
      router: {
        async generateJSON<T>(
          feature: Feature,
          req: Omit<JsonRequest<T>, 'model'>
        ): Promise<RoutedResult<T>> {
          calls.push({ feature, timeoutMs: req.timeoutMs })
          const value = answer()
          if (value instanceof Error) throw value
          return {
            value: value as T,
            route: { provider: 'ollama', model: 'qwen3.5:9b' },
            ms: 1,
            redactions: 0,
            fellBackFrom: {
              route: { provider: 'gemini', model: 'gemini-3.8-flash' },
              kind: 'rate-limit',
              message: 'Too many requests.'
            }
          }
        }
      }
    }
  }

  it('asks the digest model and says who answered', async () => {
    const { router: r, calls } = router(() => ({
      headline: 'Done a lot.',
      projects: [],
      blockers: [],
      next: []
    }))
    const digest = await writeDigest({ router: r, facts: sampleFacts(), now: () => 5 })
    expect(calls).toEqual([{ feature: 'digest', timeoutMs: 120_000 }])
    expect(digest).toMatchObject({
      headline: 'Done a lot.',
      model: 'qwen3.5:9b',
      fellBackFrom: 'rate limit',
      createdAt: 5
    })
  })

  it('writes the plain version, with the reason, when no model answers', async () => {
    const logs: string[] = []
    const { router: r } = router(() => new AIError('offline', "Can't reach Ollama. Is it running?"))
    const digest = await writeDigest({
      router: r,
      facts: sampleFacts(),
      now: () => 5,
      log: (line) => logs.push(line)
    })
    expect(digest.model).toBeUndefined()
    expect(digest.note).toBe(
      "No model answered (Can't reach Ollama. Is it running?), so Suri wrote it from its history."
    )
    expect(digest.projects[0]?.done).toContain('Add the recap writer')
    expect(logs).toHaveLength(1)
  })

  it("doesn't call a model for a day without work", async () => {
    const { router: r, calls } = router(() => new Error('should not be called'))
    const digest = await writeDigest({
      router: r,
      facts: buildDigestFacts(DAY, [], []),
      now: () => 1
    })
    expect(calls).toEqual([])
    expect(digest.turns).toBe(0)
  })
})
