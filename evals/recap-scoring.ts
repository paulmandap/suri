import { z } from 'zod'
import { describeTool } from '@shared/activity'
import { RECAP_OUTCOMES, buildTurnFacts, type RecapOutcome, type StepRecord } from '@shared/history'
import type { RecapSource } from '../src/main/history'
import { percentile } from './scoring'

// The recap eval's pure parts: the case file, turning a case into what the
// app would send, the scores and the report. No I/O, so
// tests/recap-eval-scoring.test.ts checks them without a model. No score is
// ever asserted there (CLAUDE.md).

const outcome = z.enum(['done', 'partial', 'needs-input', 'failed'])

const stepSchema = z.object({
  tool: z.string().min(1),
  /** A file, relative to the project (Read, Edit, Write). */
  path: z.string().optional(),
  /** A shell command (Bash, PowerShell). */
  command: z.string().optional(),
  /** Anything else: a pattern, a URL, a subagent's task. */
  input: z.string().optional(),
  added: z.number().int().min(0).optional(),
  removed: z.number().int().min(0).optional(),
  status: z.enum(['ok', 'failed', 'stopped']).optional()
})

export const recapCaseFileSchema = z
  .object({
    about: z.string().optional(),
    cases: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          label: outcome,
          project: z.string().min(1),
          prompt: z.string().min(1),
          steps: z.array(stepSchema),
          denied: z.array(z.string()).default([]),
          minutes: z.number().min(0).default(2),
          lastMessage: z.string().min(1),
          /** Facts the recap should state: each is a list of ways to say it (any one counts). */
          mentions: z.array(z.array(z.string().min(1)).min(1)).min(1),
          /** Claims the title or summary must not make, e.g. "tests pass" after a failed run. */
          avoid: z.array(z.string().min(1)).default([]),
          note: z.string().optional()
        })
      )
      .min(1)
  })
  .refine((file) => new Set(file.cases.map((c) => c.id)).size === file.cases.length, {
    message: 'Case ids must be unique.'
  })

export type RecapCaseFile = z.infer<typeof recapCaseFileSchema>
export type RecapCase = RecapCaseFile['cases'][number]

/** Every case lives in a made-up folder, so no real path ever reaches a model or the repo. */
export function caseFolder(c: Pick<RecapCase, 'project'>): string {
  return `C:\\work\\${c.project}`
}

/** What the app would hand the recap writer for this turn. */
export function caseSource(c: RecapCase): RecapSource {
  const cwd = caseFolder(c)
  const steps: StepRecord[] = c.steps.map((s) => {
    const input: Record<string, unknown> = s.path
      ? { file_path: `${cwd}\\${s.path.replace(/\//g, '\\')}` }
      : s.command
        ? { command: s.command }
        : { pattern: s.input ?? '', url: s.input ?? '', description: s.input ?? '' }
    const detail = String(input.file_path ?? input.command ?? s.input ?? '')
    return {
      tool: s.tool,
      kind: describeTool(s.tool, input, cwd).kind,
      detail,
      status: s.status ?? 'ok',
      ...(s.added !== undefined ? { added: s.added } : {}),
      ...(s.removed !== undefined ? { removed: s.removed } : {})
    }
  })
  return {
    project: c.project,
    prompt: c.prompt,
    facts: buildTurnFacts(steps, cwd, c.minutes * 60_000),
    denied: c.denied,
    lastMessage: c.lastMessage
  }
}

/** One case, as one model recapped it. `said` is null when it gave no answer. */
export const recapResultSchema = z.object({
  id: z.string(),
  label: outcome,
  said: outcome.nullable(),
  ms: z.number().nullable(),
  title: z.string().optional(),
  summary: z.string().optional(),
  followUps: z.array(z.string()).optional(),
  error: z.string().optional()
})

export const recapRunSchema = z.object({
  model: z.string(),
  provider: z.enum(['ollama', 'gemini']),
  date: z.string(),
  casesHash: z.string(),
  promptHash: z.string(),
  coldMs: z.number().optional(),
  results: z.array(recapResultSchema)
})

export type RecapResult = z.infer<typeof recapResultSchema>
export type RecapRun = z.infer<typeof recapRunSchema>

/** How one answer did on one case. */
export interface CaseScore {
  answered: boolean
  outcomeRight: boolean
  /** Facts stated, of those the case asks for. */
  mentioned: number
  mentions: number
  /** Claims made that the case says are false. */
  madeUp: string[]
  /** Title over 10 words or summary over 50. */
  tooLong: boolean
  /** Work was left (not done), yet no follow-up says what. */
  missingFollowUp: boolean
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

export function scoreCase(c: RecapCase, r: RecapResult | undefined): CaseScore {
  const empty: CaseScore = {
    answered: false,
    outcomeRight: false,
    mentioned: 0,
    mentions: c.mentions.length,
    madeUp: [],
    tooLong: false,
    missingFollowUp: false
  }
  if (!r || r.said === null) return empty
  const title = r.title ?? ''
  const summary = r.summary ?? ''
  const followUps = r.followUps ?? []
  const said = `${title} ${summary}`.toLowerCase()
  const all = `${said} ${followUps.join(' ')}`.toLowerCase()
  return {
    answered: true,
    outcomeRight: r.said === c.label,
    mentioned: c.mentions.filter((ways) => ways.some((way) => all.includes(way.toLowerCase())))
      .length,
    mentions: c.mentions.length,
    madeUp: c.avoid.filter((claim) => said.includes(claim.toLowerCase())),
    tooLong: words(title) > 10 || words(summary) > 50,
    missingFollowUp: c.label !== 'done' && followUps.length === 0
  }
}

export interface RunScore {
  total: number
  answered: number
  outcomeRight: number
  /** Facts stated across all cases, of all asked for. */
  mentioned: number
  mentions: number
  madeUp: number
  tooLong: number
  missingFollowUp: number
}

export function scoreRun(cases: readonly RecapCase[], run: Pick<RecapRun, 'results'>): RunScore {
  const s: RunScore = {
    total: 0,
    answered: 0,
    outcomeRight: 0,
    mentioned: 0,
    mentions: 0,
    madeUp: 0,
    tooLong: 0,
    missingFollowUp: 0
  }
  for (const c of cases) {
    const one = scoreCase(
      c,
      run.results.find((r) => r.id === c.id)
    )
    s.total++
    if (one.answered) s.answered++
    if (one.outcomeRight) s.outcomeRight++
    s.mentioned += one.mentioned
    s.mentions += one.mentions
    s.madeUp += one.madeUp.length
    if (one.tooLong) s.tooLong++
    if (one.missingFollowUp) s.missingFollowUp++
  }
  return s
}

/** Rows: the label. Columns: the outcome said, or `none`. */
export type OutcomeMatrix = Record<RecapOutcome, Record<RecapOutcome | 'none', number>>

export function outcomeMatrix(
  cases: readonly RecapCase[],
  run: Pick<RecapRun, 'results'>
): OutcomeMatrix {
  const row = (): Record<RecapOutcome | 'none', number> => ({
    done: 0,
    partial: 0,
    'needs-input': 0,
    failed: 0,
    none: 0
  })
  const matrix = Object.fromEntries(RECAP_OUTCOMES.map((o) => [o, row()])) as OutcomeMatrix
  for (const c of cases) {
    const said = run.results.find((r) => r.id === c.id)?.said ?? null
    matrix[c.label][said ?? 'none']++
  }
  return matrix
}

export interface RecapReportInput {
  cases: readonly RecapCase[]
  runs: readonly RecapRun[]
  casesHash: string
  promptHash: string
  planned: readonly string[]
}

/** The committed report, evals/results/recap.md. */
export function buildRecapReport({
  cases,
  runs,
  casesHash,
  promptHash,
  planned
}: RecapReportInput): string {
  const counts = RECAP_OUTCOMES.map(
    (o) => `${cases.filter((c) => c.label === o).length} ${o}`
  ).join(', ')
  const lines = [
    '# Recap eval results',
    '',
    `${cases.length} labelled turns (${counts}) from \`evals/recap-cases.json\`, recapped by each model`,
    "with the app's own prompt. Generated by `npm run eval:recap`; how to read it is in `evals/README.md`.",
    '',
    '| Model | Outcome right | Facts stated | Made-up claims | Too long | No follow-up | No answer | Median | p90 | Run on |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ]
  for (const run of runs) {
    const s = scoreRun(cases, run)
    const current = run.casesHash === casesHash && run.promptHash === promptHash
    const times = run.results.flatMap((r) => (typeof r.ms === 'number' ? [r.ms] : []))
    lines.push(
      row([
        `\`${run.model}\`${current ? '' : ' (older prompt or cases)'}`,
        pct(s.outcomeRight, s.total),
        pct(s.mentioned, s.mentions),
        String(s.madeUp),
        String(s.tooLong),
        String(s.missingFollowUp),
        String(s.total - s.answered),
        seconds(percentile(times, 50)),
        seconds(percentile(times, 90)),
        run.date
      ])
    )
  }
  const missing = planned.filter((model) => !runs.some((run) => run.model === model))
  if (missing.length > 0) {
    lines.push('', `Not measured yet: ${missing.map((m) => `\`${m}\``).join(', ')}.`)
  }
  const cold = runs.filter((run) => run.coldMs !== undefined)
  if (cold.length > 0) {
    const list = cold.map((run) => `\`${run.model}\` ${seconds(run.coldMs ?? null)}`)
    lines.push(
      '',
      `First call, which loads the model (not in the times above): ${list.join(', ')}.`
    )
  }
  lines.push(
    '',
    '**Outcome right**: done, partial, needs-input or failed, as labelled. **Facts stated**: the facts',
    'each case asks for, found in the title, summary or follow-ups. **Made-up claims**: things the',
    'title or summary says that the turn shows are false (watch this one). **Too long**: a title over',
    '10 words or a summary over 50. **No follow-up**: work was left, but no follow-up says what.'
  )

  for (const run of runs) {
    const matrix = outcomeMatrix(cases, run)
    lines.push('', `### \`${run.model}\` outcomes (rows: label, columns: answer)`, '')
    lines.push(
      `| | ${RECAP_OUTCOMES.join(' | ')} | none |`,
      `|---|${RECAP_OUTCOMES.map(() => '---|').join('')}---|`
    )
    for (const label of RECAP_OUTCOMES) {
      const cells = [...RECAP_OUTCOMES, 'none' as const].map((said) => String(matrix[label][said]))
      lines.push(row([`**${label}**`, ...cells]))
    }
  }

  lines.push(
    '',
    '## Every case',
    '',
    'A dash means the right outcome; otherwise the outcome said. Then facts stated, and any made-up claim.',
    '',
    row(['Case', 'Label', ...runs.map((run) => `\`${run.model}\``)]),
    `|---|---|${runs.map(() => '---|').join('')}`
  )
  for (const c of cases) {
    const cells = runs.map((run) => {
      const r = run.results.find((x) => x.id === c.id)
      if (!r) return ''
      if (r.said === null) return 'no answer'
      const one = scoreCase(c, r)
      const said = r.said === c.label ? '–' : r.said
      const made = one.madeUp.length > 0 ? `, said "${one.madeUp.join('", "')}"` : ''
      return `${said} · ${one.mentioned}/${one.mentions}${made}`
    })
    lines.push(row([c.id, c.label, ...cells]))
  }
  return lines.join('\n') + '\n'
}

function pct(n: number, of: number): string {
  return of === 0 ? '–' : `${Math.round((100 * n) / of)}%`
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`
}

function seconds(ms: number | null): string {
  if (ms === null) return '–'
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`
}
