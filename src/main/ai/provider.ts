import { z } from 'zod'
import type { AIErrorKind, ConnectionTest, ProviderId } from '@shared/ai-config'

// One interface for every model provider (plan decision 5, ADR-015). Ollama
// and Gemini implement it; the router (router.ts) picks one per feature.

export class AIError extends Error {
  constructor(
    readonly kind: AIErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'AIError'
  }
}

export interface ModelRequest {
  model: string
  system?: string
  prompt: string
  /** Cancels the call; it then fails with `aborted`. */
  signal?: AbortSignal
  /** Gives up after this long and fails with `timeout`. Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number
}

export interface JsonRequest<T> extends ModelRequest {
  /** The reply must be JSON matching this schema, or the call fails with `bad-output`. */
  schema: z.ZodType<T>
}

export interface TextRequest extends ModelRequest {
  /** Each piece of text as it streams in. */
  onText?: (chunk: string) => void
}

export interface AIProvider {
  readonly id: ProviderId
  generateJSON<T>(req: JsonRequest<T>): Promise<T>
  /** Streams to `onText` and resolves with the whole text. */
  streamText(req: TextRequest): Promise<string>
  /** Model names this provider can use right now. */
  listModels(signal?: AbortSignal): Promise<string[]>
  /** For "Test connection" in Settings. Never throws. */
  test(): Promise<ConnectionTest>
}

export const DEFAULT_TIMEOUT_MS = 60_000

/** The JSON Schema a model must follow: Zod's own, minus the `$schema` line some APIs reject. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json['$schema']
  return json
}

/** Parses a model's reply and checks it against the schema. */
export function parseJsonReply<T>(text: string, schema: z.ZodType<T>): T {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new AIError('bad-output', 'The model did not answer with JSON.')
  }
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    throw new AIError('bad-output', `The answer had the wrong shape (${where}${issue?.message}).`)
  }
  return parsed.data
}

/** One signal for the caller's cancel and our own time limit. */
export function withTimeout(
  signal: AbortSignal | undefined,
  ms: number = DEFAULT_TIMEOUT_MS
): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Turns anything thrown during a call into an AIError. `signal` is the
 * caller's own, so a cancel is told apart from our time limit.
 */
export function asAIError(
  err: unknown,
  signal: AbortSignal | undefined,
  otherwise: AIError
): AIError {
  if (err instanceof AIError) return err
  if (signal?.aborted) return new AIError('aborted', 'Cancelled.')
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new AIError('timeout', 'The model took too long to answer.')
  }
  return otherwise
}
