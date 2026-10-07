import { z } from 'zod'
import { buildDigestFacts, type Digest, type DigestFacts } from '@shared/digest'
import type { DecisionView, TurnView } from '@shared/history'
import { digestSchema } from '@shared/history-schemas'
import { percentile } from './scoring'

// The digest eval's pure parts (ADR-026): the case file, turning a case into
// the day's facts, the scores and the report. The model only rewords the
// day, so the eval checks it doesn't distort it: work in the right section,
// unfinished work never shown as done, nothing lost. No I/O, so
// tests/digest-eval-scoring.test.ts checks it without a model, and no score
// is ever asserted there (CLAUDE.md).

const outcome = z.enum(['done', 'partial', 'needs-input', 'failed'])
const count = z.number().int().min(0)
const ways = z.array(z.string().min(1)).min(1)

export const digestCaseFileSchema = z
  .object({
    about: z.string().optional(),
    cases: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          /** The day's requests, oldest first, each as its recap. */
          turns: z
            .array(
              z.object({
                project: z.string().min(1),
                title: z.string().min(1),
                outcome,
                summary: z.string().min(1),
                followUps: z.array(z.string()).default([])
              })
            )
            .min(1),
          approvals: z.object({ allowed: count, denied: count }).default({ allowed: 0, denied: 0 }),
          /** Work the notes must place: under its project, done or in progress. */
          expect: z
            .array(
              z.object({
                project: z.string().min(1),
                section: z.enum(['done', 'inProgress']),
                mentions: ways
              })
            )
            .min(1),
          /** Things that should show up as blockers, and as next steps. */
          blockers: z.array(ways).default([]),
          next: z.array(ways).default([]),
          note: z.string().optional()
        })
      )
      .min(1)
  })
  .refine((file) => new Set(file.cases.map((c) => c.id)).size === file.cases.length, {
    message: 'Case ids must be unique.'
  })

export type DigestCaseFile = z.infer<typeof digestCaseFileSchema>
export type DigestCase = DigestCaseFile['cases'][number]

/** The day's facts, through the same buildDigestFacts the app uses. */
export function caseFacts(c: DigestCase): DigestFacts {
  const turns: TurnView[] = c.turns.map((t, i) => ({
    id: i + 1,
    sessionId: 'eval',
    project: t.project,
    day: c.day,
    prompt: t.title,
    status: 'done',
    startedAt: (i + 1) * 60_000,
    decisions: [],
    recap: {
      title: t.title,
      summary: t.summary,
      outcome: t.outcome,
      followUps: t.followUps,
      model: 'case'
    }
  }))
  const decision = (o: 'allow' | 'deny'): DecisionView => ({
    tool: 'Bash',
    detail: 'command',
    outcome: o,
    askedAt: 0,
    answeredAt: 0
  })
  const decisions = [
    ...Array.from({ length: c.approvals.allowed }, () => decision('allow')),
    ...Array.from({ length: c.approvals.denied }, () => decision('deny'))
  ]
  return buildDigestFacts(c.day, turns, decisions)
}

/** One case, as one writer did it: the notes Paul would see, or why there are none. */
export const digestResultSchema = z.object({
  id: z.string(),
  ms: z.number().nullable(),
  digest: digestSchema.nullable(),
  error: z.string().optional()
})

export const digestRunSchema = z.object({
  model: z.string(),
  provider: z.enum(['ollama', 'gemini']),
  date: z.string(),
  casesHash: z.string(),
  promptHash: z.string(),
  coldMs: z.number().optional(),
  results: z.array(digestResultSchema)
})

export type DigestResult = z.infer<typeof digestResultSchema>
export type DigestRun = z.infer<typeof digestRunSchema>

export interface DigestCaseScore {
  answered: boolean
  /** Expected work found in its project's right section. */
  placed: number
  items: number
  /** Unfinished work shown under done (and nowhere under in progress). The number to watch. */
  claimedDone: number
  /** Expected work found nowhere in the notes. */
  missing: number
  blockers: number
  blockersWanted: number
  next: number
  nextWanted: number
  /** A headline over 30 words. */
  longHeadline: boolean
}

const found = (texts: readonly string[], alternatives: readonly string[]): boolean => {
  const all = texts.join('\n').toLowerCase()
  return alternatives.some((way) => all.includes(way.toLowerCase()))
}

export function scoreDigestCase(c: DigestCase, digest: Digest | null): DigestCaseScore {
  const score: DigestCaseScore = {
    answered: digest !== null,
    placed: 0,
    items: c.expect.length,
    claimedDone: 0,
    missing: 0,
    blockers: 0,
    blockersWanted: c.blockers.length,
    next: 0,
    nextWanted: c.next.length,
    longHeadline: false
  }
  if (!digest) {
    score.missing = c.expect.length
    return score
  }
  const everywhere = [
    digest.headline,
    ...digest.blockers,
    ...digest.next,
    ...digest.projects.flatMap((p) => [...p.done, ...p.inProgress])
  ]
  for (const item of c.expect) {
    const project = digest.projects.find((p) => p.name.toLowerCase() === item.project.toLowerCase())
    const inDone = project ? found(project.done, item.mentions) : false
    const inProgress = project ? found(project.inProgress, item.mentions) : false
    if (item.section === 'done' ? inDone : inProgress) score.placed++
    if (item.section === 'inProgress' && inDone && !inProgress) score.claimedDone++
    if (!inDone && !inProgress && !found(everywhere, item.mentions)) score.missing++
  }
  score.blockers = c.blockers.filter((b) => found(digest.blockers, b)).length
  score.next = c.next.filter((n) => found(digest.next, n)).length
  score.longHeadline = digest.headline.split(/\s+/).filter(Boolean).length > 30
  return score
}

export interface DigestRunScore {
  cases: number
  answered: number
  placed: number
  items: number
  claimedDone: number
  missing: number
  blockers: number
  blockersWanted: number
  next: number
  nextWanted: number
  longHeadline: number
}

export function scoreDigestRun(
  cases: readonly DigestCase[],
  digestOf: (c: DigestCase) => Digest | null
): DigestRunScore {
  const total: DigestRunScore = {
    cases: 0,
    answered: 0,
    placed: 0,
    items: 0,
    claimedDone: 0,
    missing: 0,
    blockers: 0,
    blockersWanted: 0,
    next: 0,
    nextWanted: 0,
    longHeadline: 0
  }
  for (const c of cases) {
    const s = scoreDigestCase(c, digestOf(c))
    total.cases++
    if (s.answered) total.answered++
    total.placed += s.placed
    total.items += s.items
    total.claimedDone += s.claimedDone
    total.missing += s.missing
    total.blockers += s.blockers
    total.blockersWanted += s.blockersWanted
    total.next += s.next
    total.nextWanted += s.nextWanted
    if (s.longHeadline) total.longHeadline++
  }
  return total
}

export interface DigestReportInput {
  cases: readonly DigestCase[]
  runs: readonly DigestRun[]
  /** Suri's own plain notes for each case: the baseline row. */
  plain: (c: DigestCase) => Digest
  casesHash: string
  promptHash: string
  planned: readonly string[]
}

/** The committed report, evals/results/digest.md. */
export function buildDigestReport({
  cases,
  runs,
  plain,
  casesHash,
  promptHash,
  planned
}: DigestReportInput): string {
  const items = cases.reduce((n, c) => n + c.expect.length, 0)
  const lines = [
    '# Digest eval results',
    '',
    `${cases.length} days with ${items} pieces of work to place, from \`evals/digest-cases.json\`, written`,
    "by each model with the app's own prompt, then held to the day's facts like the app does.",
    '**Suri alone** is the plain version Suri writes when no model answers. Generated by',
    '`npm run eval:digest`; how to read it is in `evals/README.md`.',
    '',
    '| Who writes | Placed right | Claimed done | Missing | Blockers | Next steps | Long headline | No answer | Median | Run on |',
    '|---|---|---|---|---|---|---|---|---|---|',
    row(['Suri alone (no model)', ...cells(scoreDigestRun(cases, plain)), '–', '–'])
  ]
  for (const run of runs) {
    const current = run.casesHash === casesHash && run.promptHash === promptHash
    const byId = new Map(run.results.map((r) => [r.id, r]))
    const s = scoreDigestRun(cases, (c) => byId.get(c.id)?.digest ?? null)
    const times = run.results.flatMap((r) => (typeof r.ms === 'number' ? [r.ms] : []))
    lines.push(
      row([
        `\`${run.model}\`${current ? '' : ' (older prompt or cases)'}`,
        ...cells(s),
        seconds(percentile(times, 50)),
        run.date
      ])
    )
  }
  const missing = planned.filter((model) => !runs.some((run) => run.model === model))
  if (missing.length > 0) {
    lines.push('', `Not measured yet: ${missing.map((m) => `\`${m}\``).join(', ')}.`)
  }
  lines.push(
    '',
    '**Placed right**: each piece of work found under its project, in the section it belongs to (done',
    'or in progress). **Claimed done**: unfinished work shown as done, the number to watch.',
    '**Missing**: work found nowhere in the notes. **Blockers** and **Next steps**: the ones each day',
    'should list, found there. **Long headline**: over 30 words.',
    '',
    '## Every day',
    '',
    'Placed right / pieces of work, then anything claimed done or missing.',
    '',
    row(['Day', 'Suri alone', ...runs.map((run) => `\`${run.model}\``)]),
    `|---|---|${runs.map(() => '---|').join('')}`
  )
  for (const c of cases) {
    const cell = (digest: Digest | null): string => {
      if (!digest) return 'no answer'
      const s = scoreDigestCase(c, digest)
      const extra = [
        s.claimedDone ? `${s.claimedDone} claimed done` : '',
        s.missing ? `${s.missing} missing` : ''
      ].filter(Boolean)
      return `${s.placed}/${s.items}${extra.length ? `, ${extra.join(', ')}` : ''}`
    }
    const answers = runs.map((run) => {
      const r = run.results.find((x) => x.id === c.id)
      return r ? cell(r.digest) : ''
    })
    lines.push(row([c.id, cell(plain(c)), ...answers]))
  }
  return lines.join('\n') + '\n'
}

function cells(s: DigestRunScore): string[] {
  return [
    pct(s.placed, s.items),
    String(s.claimedDone),
    String(s.missing),
    `${s.blockers}/${s.blockersWanted}`,
    `${s.next}/${s.nextWanted}`,
    String(s.longHeadline),
    String(s.cases - s.answered)
  ]
}

function pct(n: number, of: number): string {
  return of === 0 ? '–' : `${Math.round((100 * n) / of)}%`
}

function row(values: readonly string[]): string {
  return `| ${values.join(' | ')} |`
}

function seconds(ms: number | null): string {
  if (ms === null) return '–'
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`
}
