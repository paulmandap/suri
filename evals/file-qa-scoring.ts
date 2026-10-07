import { z } from 'zod'
import { pickChunks, type Chunk } from '../src/main/ai/file-qa'
import { percentile } from './scoring'

// The file-question eval's pure parts (ADR-027): the case file, the scores,
// the retrieval check and the report. No I/O and no model, so
// tests/file-qa-eval-scoring.test.ts checks them; no score is ever asserted
// there (CLAUDE.md).

const ways = z.array(z.string().min(1)).min(1)

export const fileQaCaseFileSchema = z
  .object({
    about: z.string().optional(),
    /** Name → file in evals/documents/. */
    documents: z.record(z.string(), z.string().min(1)),
    cases: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          doc: z.string().min(1),
          question: z.string().min(1),
          /** Facts the answer should state. */
          mentions: z.array(ways).default([]),
          /** False: the document doesn't say, and the answer should say so. */
          answerable: z.boolean().default(true)
        })
      )
      .min(1)
  })
  .refine((file) => file.cases.every((c) => c.doc in file.documents), {
    message: 'Every case must name a listed document.'
  })
  .refine((file) => file.cases.every((c) => !c.answerable || c.mentions.length > 0), {
    message: 'An answerable case needs the facts its answer should state.'
  })

export type FileQaCaseFile = z.infer<typeof fileQaCaseFileSchema>
export type FileQaCase = FileQaCaseFile['cases'][number]

export const fileQaResultSchema = z.object({
  id: z.string(),
  ms: z.number().nullable(),
  answer: z.string().nullable(),
  error: z.string().optional()
})

export const fileQaRunSchema = z.object({
  model: z.string(),
  provider: z.enum(['ollama', 'gemini']),
  date: z.string(),
  casesHash: z.string(),
  promptHash: z.string(),
  coldMs: z.number().optional(),
  results: z.array(fileQaResultSchema)
})

export type FileQaResult = z.infer<typeof fileQaResultSchema>
export type FileQaRun = z.infer<typeof fileQaRunSchema>

/** Ways a model says the document doesn't answer the question. */
const NOT_IN_DOCUMENT = [
  "doesn't say",
  'does not say',
  "doesn't mention",
  'does not mention',
  'not mentioned',
  "doesn't specify",
  'does not specify',
  'not specified',
  "doesn't include",
  'does not include',
  "doesn't contain",
  'does not contain',
  "doesn't state",
  'does not state',
  'not stated',
  "doesn't cover",
  'does not cover',
  'not covered',
  "isn't in",
  'is not in',
  'not in the document',
  'no information',
  'no mention',
  'not provided',
  "doesn't provide",
  'does not provide'
]

const normal = (text: string): string => text.toLowerCase().replace(/[‘’]/g, "'")

export function saysNotInDocument(answer: string): boolean {
  const text = normal(answer)
  return NOT_IN_DOCUMENT.some((phrase) => text.includes(phrase))
}

export interface FileQaCaseScore {
  answered: boolean
  /** For an answerable question: facts stated, of those asked for. */
  mentioned: number
  mentions: number
  /** For an unanswerable one: did it say the document doesn't tell? */
  saidNotInDocument: boolean
}

export function scoreFileQaCase(c: FileQaCase, answer: string | null): FileQaCaseScore {
  const score: FileQaCaseScore = {
    answered: answer !== null,
    mentioned: 0,
    mentions: c.answerable ? c.mentions.length : 0,
    saidNotInDocument: false
  }
  if (answer === null) return score
  const text = normal(answer)
  if (c.answerable) {
    score.mentioned = c.mentions.filter((alternatives) =>
      alternatives.some((way) => text.includes(normal(way)))
    ).length
  } else {
    score.saidNotInDocument = saysNotInDocument(answer)
  }
  return score
}

export interface FileQaRunScore {
  cases: number
  answered: number
  mentioned: number
  mentions: number
  unanswerable: number
  saidNotInDocument: number
}

export function scoreFileQaRun(
  cases: readonly FileQaCase[],
  answerOf: (c: FileQaCase) => string | null
): FileQaRunScore {
  const total: FileQaRunScore = {
    cases: 0,
    answered: 0,
    mentioned: 0,
    mentions: 0,
    unanswerable: 0,
    saidNotInDocument: 0
  }
  for (const c of cases) {
    const s = scoreFileQaCase(c, answerOf(c))
    total.cases++
    if (s.answered) total.answered++
    total.mentioned += s.mentioned
    total.mentions += s.mentions
    if (!c.answerable) {
      total.unanswerable++
      if (s.saidNotInDocument) total.saidNotInDocument++
    }
  }
  return total
}

/**
 * Whether Suri's chunk picker put the answer in front of a local model: every
 * fact the question asks for appears in the chunks it picks. No model needed.
 */
export function retrievalHit(c: FileQaCase, chunks: readonly Chunk[], budget: number): boolean {
  const picked = normal(
    pickChunks(chunks, c.question, budget)
      .map((chunk) => chunk.text)
      .join('\n')
  )
  return c.mentions.every((alternatives) =>
    alternatives.some((way) => picked.includes(normal(way)))
  )
}

export interface FileQaReportInput {
  cases: readonly FileQaCase[]
  runs: readonly FileQaRun[]
  /** Answerable questions on documents too long for a local model, and how many retrieval found. */
  retrieval: { hits: number; of: number; missed: string[] }
  casesHash: string
  promptHash: string
  planned: readonly string[]
}

/** The committed report, evals/results/file-qa.md. */
export function buildFileQaReport({
  cases,
  runs,
  retrieval,
  casesHash,
  promptHash,
  planned
}: FileQaReportInput): string {
  const answerable = cases.filter((c) => c.answerable).length
  const lines = [
    '# File question eval results',
    '',
    `${cases.length} questions (${answerable} answerable, ${cases.length - answerable} not) about two frozen`,
    "documents in `evals/documents/`, asked with the app's own prompt. A local model sees only the chunks",
    'Suri picks; Gemini sees the whole file. Generated by `npm run eval:files`; see `evals/README.md`.',
    '',
    `**Retrieval** (no model): for ${retrieval.hits} of ${retrieval.of} answerable questions on the long`,
    'document, the chunks Suri picks for a local model hold every fact the answer needs' +
      (retrieval.missed.length > 0 ? ` (missed: ${retrieval.missed.join(', ')}).` : '.'),
    '',
    '| Model | Facts stated | Said "it doesn\'t say" when it doesn\'t | No answer | Median | Run on |',
    '|---|---|---|---|---|---|'
  ]
  for (const run of runs) {
    const current = run.casesHash === casesHash && run.promptHash === promptHash
    const byId = new Map(run.results.map((r) => [r.id, r]))
    const s = scoreFileQaRun(cases, (c) => byId.get(c.id)?.answer ?? null)
    const times = run.results.flatMap((r) => (typeof r.ms === 'number' ? [r.ms] : []))
    lines.push(
      row([
        `\`${run.model}\`${current ? '' : ' (older prompt or cases)'}`,
        pct(s.mentioned, s.mentions),
        `${s.saidNotInDocument}/${s.unanswerable}`,
        String(s.cases - s.answered),
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
    '**Facts stated**: the facts each answerable question asks for, found in the answer. **Said "it',
    "doesn't say\"**: questions the document can't answer, where the answer says so instead of guessing.",
    '',
    '## Every question',
    '',
    'Facts stated, or for an unanswerable question "says so" or "GUESSED".',
    '',
    row(['Question', ...runs.map((run) => `\`${run.model}\``)]),
    `|---|${runs.map(() => '---|').join('')}`
  )
  for (const c of cases) {
    const cells = runs.map((run) => {
      const r = run.results.find((x) => x.id === c.id)
      if (!r) return ''
      if (r.answer === null) return 'no answer'
      const s = scoreFileQaCase(c, r.answer)
      if (!c.answerable) return s.saidNotInDocument ? 'says so' : 'GUESSED'
      return `${s.mentioned}/${s.mentions}`
    })
    lines.push(row([c.id, ...cells]))
  }
  return lines.join('\n') + '\n'
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
