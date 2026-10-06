import { z } from 'zod'
import { DEFAULT_OLLAMA_URL, isLoopbackUrl, type ConnectionTest } from '@shared/ai-config'
import {
  AIError,
  asAIError,
  jsonSchemaOf,
  parseJsonReply,
  withTimeout,
  type AIProvider,
  type JsonRequest,
  type ModelRequest,
  type TextRequest
} from './provider'

// Ollama's REST API, with the shapes Ollama 0.35.1 sent on this PC (2026-10-05).
// Every failure becomes an AIError whose message can go straight into Settings.

/** Listing models only reads local files, so a few seconds means Ollama is stuck. */
const QUICK_TIMEOUT_MS = 5_000

// Only the fields Suri reads. Ollama sends more (timings, sizes, digests).
const errorReply = z.object({ error: z.string() })
const chatReply = z.object({ message: z.object({ content: z.string() }) })
const chatLine = z.object({
  message: z.object({ content: z.string() }).optional(),
  done: z.boolean()
})
const tagsReply = z.object({ models: z.array(z.object({ name: z.string() })) })
const versionReply = z.object({ version: z.string() })

/** Runs one network step (the fetch, a body read), turning any failure into an AIError. */
type Net = <R>(step: () => Promise<R>) => Promise<R>

interface Call {
  /** Only for /api/chat, where a 404 means this model isn't pulled. */
  model?: string
  /** Sent as JSON in a POST; without one the request is a GET. */
  body?: Record<string, unknown>
  signal?: AbortSignal
  timeoutMs?: number
}

interface Opened {
  res: Response
  net: Net
}

export function createOllamaProvider(opts: {
  url: () => string
  fetch?: typeof fetch
}): AIProvider {
  /** Sends one request. Resolves with a 2xx response; anything else throws an AIError. */
  async function open(base: string, path: string, call: Call): Promise<Opened> {
    // "Local" is the privacy promise: prompts for Ollama are never redacted.
    if (!isLoopbackUrl(base)) {
      throw new AIError(
        'other',
        `Ollama must run on this PC, at an address like ${DEFAULT_OLLAMA_URL}.`
      )
    }
    const signal = withTimeout(call.signal, call.timeoutMs)
    const offline = new AIError('offline', `Can't reach Ollama at ${base}. Is it running?`)

    async function net<R>(step: () => Promise<R>): Promise<R> {
      try {
        return await step()
      } catch (err) {
        // Another fetch (Electron's net.fetch) may end a cut-off body read with a
        // plain AbortError; the signal's reason still tells our time limit apart.
        const cause = err instanceof AIError || !signal.aborted ? err : signal.reason
        throw asAIError(cause, call.signal, offline)
      }
    }

    const send = opts.fetch ?? fetch
    const post = call.body !== undefined
    const res = await net(() =>
      send(new URL(path, base), {
        method: post ? 'POST' : 'GET',
        headers: post ? { 'content-type': 'application/json' } : undefined,
        body: post ? JSON.stringify(call.body) : undefined,
        // A redirect would carry the prompt to wherever it points.
        redirect: 'manual',
        signal
      })
    )
    if (!res.ok) throw await failure(res, net, base, call.model)
    return { res, net }
  }

  async function getJson<T>(
    base: string,
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const { res, net } = await open(base, path, { signal, timeoutMs: QUICK_TIMEOUT_MS })
    return parseOllama(await net(() => res.text()), schema, base)
  }

  async function modelsAt(base: string, signal?: AbortSignal): Promise<string[]> {
    const { models } = await getJson(base, '/api/tags', tagsReply, signal)
    return models.map((model) => model.name).sort()
  }

  return {
    id: 'ollama',

    async generateJSON<T>(req: JsonRequest<T>): Promise<T> {
      const base = opts.url()
      const { res, net } = await open(base, '/api/chat', {
        model: req.model,
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        body: {
          model: req.model,
          messages: messagesOf(req),
          format: jsonSchemaOf(req.schema),
          stream: false,
          // false works on every model and turns thinking off where it exists;
          // true fails on models that can't think.
          think: false,
          // Same input, same answer: a rating shouldn't change between runs.
          options: { temperature: 0 }
        }
      })
      const reply = parseOllama(await net(() => res.text()), chatReply, base)
      return parseJsonReply(reply.message.content, req.schema)
    },

    async streamText(req: TextRequest): Promise<string> {
      const base = opts.url()
      const { res, net } = await open(base, '/api/chat', {
        model: req.model,
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        // No temperature: free text keeps the model's own sampling settings,
        // since greedy decoding can loop on long answers.
        body: { model: req.model, messages: messagesOf(req), stream: true, think: false }
      })
      return readStream(res, net, base, req.onText)
    },

    async listModels(signal?: AbortSignal): Promise<string[]> {
      return modelsAt(opts.url(), signal)
    },

    async test(): Promise<ConnectionTest> {
      try {
        const base = opts.url()
        const { version } = await getJson(base, '/api/version', versionReply)
        const models = await modelsAt(base)
        return { ok: true, detail: `Ollama ${version}`, models }
      } catch (err) {
        const failed = asAIError(err, undefined, new AIError('other', "Suri couldn't test Ollama."))
        return { ok: false, kind: failed.kind, message: failed.message }
      }
    }
  }
}

function messagesOf(req: ModelRequest): { role: 'system' | 'user'; content: string }[] {
  const user = { role: 'user' as const, content: req.prompt }
  return req.system ? [{ role: 'system', content: req.system }, user] : [user]
}

/**
 * Reads Ollama's NDJSON stream: one JSON object per line, the last with
 * `done: true`. A line, or even one character, can be split across chunks.
 */
async function readStream(
  res: Response,
  net: Net,
  base: string,
  onText?: (chunk: string) => void
): Promise<string> {
  if (!res.body) throw strange(base)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const pieces: string[] = []
  let tail = ''
  let finished = false

  const take = (line: string): void => {
    if (!line.trim()) return
    const piece = parseOllama(line, chatLine, base)
    const text = piece.message?.content
    if (text) {
      pieces.push(text)
      onText?.(text)
    }
    if (piece.done) finished = true
  }

  try {
    for (;;) {
      const chunk = await net(() => reader.read())
      if (chunk.done) break
      tail += decoder.decode(chunk.value, { stream: true })
      const lines = tail.split('\n')
      tail = lines.pop() ?? ''
      for (const line of lines) take(line)
    }
    take(tail + decoder.decode())
  } catch (err) {
    // Hanging up tells Ollama to stop writing an answer nobody will read.
    void reader.cancel().catch(() => {})
    throw err
  }
  if (!finished) throw new AIError('unavailable', 'Ollama stopped before the answer was finished.')
  return pieces.join('')
}

/** One JSON reply (or one stream line) from Ollama, which may be an `{ error }` instead. */
function parseOllama<T>(text: string, schema: z.ZodType<T>, base: string): T {
  const data = readJson(text)
  const error = errorReply.safeParse(data)
  if (error.success) throw new AIError('other', error.data.error)
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw strange(base)
  return parsed.data
}

/** An error status as an AIError, in Ollama's own words where it gave any. */
async function failure(
  res: Response,
  net: Net,
  base: string,
  model: string | undefined
): Promise<AIError> {
  const reply = errorReply.safeParse(readJson(await net(() => res.text())))
  const said = reply.success ? reply.data.error : ''
  if (res.status === 404 && model !== undefined) {
    return new AIError(
      'not-found',
      `Ollama doesn't have "${model}". Get it with: ollama pull ${model}`
    )
  }
  if (res.status >= 500) {
    return new AIError(
      'unavailable',
      said ? `Ollama couldn't answer: ${said}` : `Ollama couldn't answer (error ${res.status}).`
    )
  }
  // No `{ error }` body: probably another program on Ollama's port.
  return new AIError('other', said || `${base} answered with error ${res.status}. Is it Ollama?`)
}

function strange(base: string): AIError {
  return new AIError('other', `The answer from ${base} doesn't look like Ollama's.`)
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
