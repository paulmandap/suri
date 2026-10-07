import { z } from 'zod'

// What the history reads back from disk, and what the History window may send
// (CLAUDE.md: Zod at every boundary). Main-only at runtime: the sandboxed
// preload can't load zod. A JSON column that doesn't match reads as missing.

const outcome = z.enum(['done', 'partial', 'needs-input', 'failed'])
const count = z.number().int().min(0)

export const turnFactsSchema = z.object({
  durationMs: z.number().min(0),
  steps: count,
  filesChanged: z.array(z.object({ path: z.string(), added: count, removed: count })),
  moreFiles: count,
  linesAdded: count,
  linesRemoved: count,
  commands: z.array(z.object({ command: z.string(), status: z.enum(['ok', 'failed', 'stopped']) })),
  moreCommands: count,
  reads: count,
  searches: count,
  web: count,
  agents: count,
  failed: count
})

export const recapSchema = z.object({
  title: z.string(),
  summary: z.string(),
  outcome,
  followUps: z.array(z.string()),
  model: z.string(),
  fellBackFrom: z.string().optional()
})

export const digestSchema = z.object({
  day: z.string(),
  headline: z.string(),
  projects: z.array(
    z.object({ name: z.string(), done: z.array(z.string()), inProgress: z.array(z.string()) })
  ),
  blockers: z.array(z.string()),
  next: z.array(z.string()),
  stats: z.string(),
  model: z.string().optional(),
  fellBackFrom: z.string().optional(),
  note: z.string().optional(),
  turns: count,
  createdAt: z.number()
})

/** A local date the History window asks about. */
export const daySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)

export const turnIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

/** Parses a JSON column, or undefined when it's empty or doesn't match. */
export function parseColumn<T>(value: unknown, schema: z.ZodType<T>): T | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed = schema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
