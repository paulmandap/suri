import { z } from 'zod'
import type { ConnectionTest } from '@shared/ai-config'
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

// Gemini over its REST API with plain fetch (ADR-030; the SDK of ADR-015 sent
// these same requests, byte for byte in the bodies). Three calls: an answer
// as JSON, a streamed answer, and the list of models. The router has already
// taken secrets out of every prompt that reaches this file.

/** Listing models is quick; this long means Gemini or the network is stuck. */
const QUICK_TIMEOUT_MS = 10_000
/** Pages of 100 models; Google lists about 50, so this is only a backstop. */
const MAX_MODEL_PAGES = 5

// Pinned in code and never read from the environment: the key and the
// prompts only ever go to Google's Gemini API.
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/'

// Only the fields Suri reads. Gemini sends more (usage, safety ratings, ids).
const part = z.object({ text: z.string().optional(), thought: z.boolean().optional() })
const contentReply = z.object({
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(part).optional() }).optional() }))
    .optional()
})
const modelsReply = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        supportedGenerationMethods: z.array(z.string()).optional()
      })
    )
    .optional(),
  nextPageToken: z.string().optional()
})
const errorReply = z.object({ error: z.object({ message: z.string().optional() }) })

export function createGeminiProvider(opts: {
  apiKey: () => string | null
  fetch?: typeof fetch
}): AIProvider {
  /** The saved key. No key fails before anything goes on the network. */
  function savedKey(): string {
    const key = opts.apiKey()
    if (!key) throw new AIError('no-key', 'No Gemini API key saved. Add one in Settings → AI.')
    return key
  }

  /**
   * One request. Resolves with a 2xx response; anything else throws an
   * AIError. Never retried, so a 429 reaches the router at once and the
   * local model can answer.
   */
  async function send(
    path: string,
    key: string,
    signal: AbortSignal,
    model: string,
    body?: Record<string, unknown>
  ): Promise<Response> {
    const res = await (opts.fetch ?? fetch)(new URL(path, GEMINI_API), {
      method: body ? 'POST' : 'GET',
      // In a header, not the URL, so it never lands in a log line.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: body ? JSON.stringify(body) : undefined,
      // A redirect would carry the key to wherever it points.
      redirect: 'manual',
      signal
    })
    if (!res.ok) throw fromStatus(res.status, errorText(await res.text()), model)
    return res
  }

  async function listModels(caller?: AbortSignal): Promise<string[]> {
    const key = savedKey()
    const signal = withTimeout(caller, QUICK_TIMEOUT_MS)
    try {
      const names: string[] = []
      let pageToken: string | undefined
      for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        const query = new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) })
        const res = await send(`models?${query}`, key, signal, '')
        const reply = parseGemini(await res.text(), modelsReply)
        for (const model of reply.models ?? []) {
          if (
            model.name.startsWith('models/gemini') &&
            model.supportedGenerationMethods?.includes('generateContent')
          ) {
            names.push(model.name.slice('models/'.length))
          }
        }
        pageToken = reply.nextPageToken
        if (!pageToken) break
      }
      return names.sort()
    } catch (err) {
      throw geminiError(err, caller, signal, key)
    }
  }

  return {
    id: 'gemini',

    async generateJSON<T>(req: JsonRequest<T>): Promise<T> {
      const key = savedKey()
      const signal = withTimeout(req.signal, req.timeoutMs)
      try {
        const res = await send(modelPath(req.model, 'generateContent'), key, signal, req.model, {
          ...promptOf(req),
          generationConfig: {
            // Same input, same answer: a rating shouldn't change between runs.
            temperature: 0,
            responseMimeType: 'application/json',
            responseJsonSchema: jsonSchemaOf(req.schema)
          }
        })
        const reply = parseGemini(await res.text(), contentReply)
        return parseJsonReply(textOf(reply), req.schema)
      } catch (err) {
        throw geminiError(err, req.signal, signal, key)
      }
    },

    async streamText(req: TextRequest): Promise<string> {
      const key = savedKey()
      const signal = withTimeout(req.signal, req.timeoutMs)
      try {
        const res = await send(
          `${modelPath(req.model, 'streamGenerateContent')}?alt=sse`,
          key,
          signal,
          req.model,
          { ...promptOf(req), generationConfig: {} }
        )
        return await readEvents(res, req.onText)
      } catch (err) {
        throw geminiError(err, req.signal, signal, key)
      }
    },

    listModels,

    async test(): Promise<ConnectionTest> {
      try {
        const models = await listModels()
        return { ok: true, detail: `Key works · ${models.length} models`, models }
      } catch (err) {
        const failed =
          err instanceof AIError ? err : new AIError('other', "Suri couldn't test Gemini.")
        return { ok: false, kind: failed.kind, message: failed.message }
      }
    }
  }
}

/** Model ids are checked before use (isValidModel), so this is a plain path. */
function modelPath(model: string, method: string): string {
  return `models/${encodeURIComponent(model)}:${method}`
}

/** The request's text, in the shape the SDK sent it (role included). */
function promptOf(req: ModelRequest): Record<string, unknown> {
  return {
    contents: [{ parts: [{ text: req.prompt }], role: 'user' }],
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }], role: 'user' } } : {})
  }
}

/** The answer's text: the first candidate's parts, without any thinking. */
function textOf(reply: z.infer<typeof contentReply>): string {
  const parts = reply.candidates?.[0]?.content?.parts ?? []
  return parts
    .filter((p) => p.thought !== true)
    .map((p) => p.text ?? '')
    .join('')
}

/**
 * Reads the server-sent events of a streamed answer: one `data: {json}` line
 * per piece, a blank line between them. A line can be split across chunks.
 */
async function readEvents(res: Response, onText?: (chunk: string) => void): Promise<string> {
  if (!res.body) throw new AIError('other', 'Gemini sent an empty answer.')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const pieces: string[] = []
  let tail = ''

  const take = (line: string): void => {
    if (!line.startsWith('data:')) return
    const data = line.slice('data:'.length).trim()
    if (!data) return
    const said = errorReply.safeParse(readJson(data))
    if (said.success) {
      throw new AIError('unavailable', `Gemini stopped: ${said.data.error.message ?? 'no reason'}`)
    }
    const text = textOf(parseGemini(data, contentReply))
    if (!text) return
    pieces.push(text)
    onText?.(text)
  }

  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      tail += decoder.decode(chunk.value, { stream: true })
      const lines = tail.split(/\r?\n/)
      tail = lines.pop() ?? ''
      for (const line of lines) take(line)
    }
    take(tail + decoder.decode())
  } catch (err) {
    // Hanging up tells Gemini to stop writing an answer nobody will read.
    void reader.cancel().catch(() => {})
    throw err
  }
  return pieces.join('')
}

/** One JSON reply from Gemini, checked for the fields Suri reads. */
function parseGemini<T>(text: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(readJson(text))
  if (!parsed.success) throw new AIError('other', "Gemini's answer didn't look like Gemini's.")
  return parsed.data
}

/**
 * Any failure as an AIError whose message can go straight into Settings.
 * `caller` is the caller's own signal, `signal` ours with the time limit.
 * The key is scrubbed from every message, whatever produced it.
 */
function geminiError(
  err: unknown,
  caller: AbortSignal | undefined,
  signal: AbortSignal,
  key: string
): AIError {
  let error: AIError
  if (err instanceof AIError) error = err
  else {
    // A cut-off read may end in a plain AbortError; our signal's reason tells
    // a time-out from a cancel.
    const cause = signal.aborted ? signal.reason : err
    const otherwise =
      err instanceof TypeError
        ? new AIError('offline', "Can't reach Gemini. Are you online?")
        : new AIError('other', `Gemini failed: ${err instanceof Error ? err.message : String(err)}`)
    error = asAIError(cause, caller, otherwise)
  }
  return key && error.message.includes(key)
    ? new AIError(error.kind, error.message.split(key).join('[key]'))
    : error
}

function fromStatus(status: number, said: string, model: string): AIError {
  if (status === 429) {
    return new AIError('rate-limit', "Gemini's free-tier limit was hit. Try again in a minute.")
  }
  if (status === 401 || (status === 400 && /api key/i.test(said))) {
    return new AIError('auth', 'Gemini rejected the API key.')
  }
  // 403 is also "not available where you are" or "API not enabled": show Gemini's words.
  if (status === 403) {
    return new AIError('auth', said ? `Gemini refused: ${said}` : 'Gemini rejected the API key.')
  }
  if (status === 404) return new AIError('not-found', `Gemini has no model called "${model}".`)
  if (status >= 500) {
    return new AIError('unavailable', 'Gemini is having trouble right now. Try again later.')
  }
  return new AIError('other', said ? `Gemini said: ${said}` : `Gemini answered ${status}.`)
}

/** Gemini's own message from an error body like {"error":{"message":"…"}}. */
function errorText(body: string): string {
  const said = errorReply.safeParse(readJson(body))
  return said.success ? (said.data.error.message ?? '') : ''
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
