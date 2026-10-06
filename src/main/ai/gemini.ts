import { ApiError, GoogleGenAI } from '@google/genai'
import type { ConnectionTest } from '@shared/ai-config'
import {
  AIError,
  asAIError,
  jsonSchemaOf,
  parseJsonReply,
  withTimeout,
  type AIProvider,
  type JsonRequest,
  type TextRequest
} from './provider'

// Gemini through the official SDK (ADR-004, ADR-015). The router has already
// taken secrets out of every prompt that reaches this file.

/** Listing models is quick; this long means Gemini or the network is stuck. */
const QUICK_TIMEOUT_MS = 10_000

// Pinned in code: otherwise GOOGLE_GENAI_USE_VERTEXAI or GOOGLE_GEMINI_BASE_URL
// in the environment could send the key and prompts somewhere Paul never chose.
const GEMINI_API = 'https://generativelanguage.googleapis.com/'

export function createGeminiProvider(opts: {
  apiKey: () => string | null
  fetch?: typeof fetch
}): AIProvider {
  let cached: { key: string; client: GoogleGenAI } | null = null

  /** The client for the saved key. No key fails before anything goes on the network. */
  function connect(): { key: string; client: GoogleGenAI } {
    const key = opts.apiKey()
    if (!key) throw new AIError('no-key', 'No Gemini API key saved. Add one in Settings → AI.')
    if (cached?.key !== key) {
      // No retryOptions: the SDK then never retries, so a 429 comes back at
      // once and the router can let the local model answer.
      const httpOptions = { baseUrl: GEMINI_API, ...(opts.fetch ? { fetch: opts.fetch } : {}) }
      cached = { key, client: new GoogleGenAI({ apiKey: key, vertexai: false, httpOptions }) }
    }
    return cached
  }

  async function listModels(caller?: AbortSignal): Promise<string[]> {
    const { key, client } = connect()
    const signal = withTimeout(caller, QUICK_TIMEOUT_MS)
    try {
      const pager = await client.models.list({ config: { pageSize: 100, abortSignal: signal } })
      const names: string[] = []
      for await (const model of pager) {
        const name = model.name ?? ''
        if (
          name.startsWith('models/gemini') &&
          model.supportedActions?.includes('generateContent')
        ) {
          names.push(name.slice('models/'.length))
        }
      }
      return names.sort()
    } catch (err) {
      throw geminiError(err, caller, signal, key, '')
    }
  }

  return {
    id: 'gemini',

    async generateJSON<T>(req: JsonRequest<T>): Promise<T> {
      const { key, client } = connect()
      const signal = withTimeout(req.signal, req.timeoutMs)
      try {
        const response = await client.models.generateContent({
          model: req.model,
          contents: req.prompt,
          config: {
            systemInstruction: req.system,
            responseMimeType: 'application/json',
            responseJsonSchema: jsonSchemaOf(req.schema),
            // Same input, same answer: a rating shouldn't change between runs.
            temperature: 0,
            abortSignal: signal
          }
        })
        return parseJsonReply(response.text ?? '', req.schema)
      } catch (err) {
        throw geminiError(err, req.signal, signal, key, req.model)
      }
    },

    async streamText(req: TextRequest): Promise<string> {
      const { key, client } = connect()
      const signal = withTimeout(req.signal, req.timeoutMs)
      const pieces: string[] = []
      try {
        const stream = await client.models.generateContentStream({
          model: req.model,
          contents: req.prompt,
          config: { systemInstruction: req.system, abortSignal: signal }
        })
        for await (const chunk of stream) {
          const text = chunk.text
          if (!text) continue
          pieces.push(text)
          req.onText?.(text)
        }
      } catch (err) {
        throw geminiError(err, req.signal, signal, key, req.model)
      }
      return pieces.join('')
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

/**
 * Any failure as an AIError whose message can go straight into Settings.
 * `caller` is the caller's own signal, `signal` ours with the time limit.
 * The key is scrubbed from every message, whatever produced it.
 */
function geminiError(
  err: unknown,
  caller: AbortSignal | undefined,
  signal: AbortSignal,
  key: string,
  model: string
): AIError {
  let error: AIError
  if (err instanceof AIError) error = err
  else if (err instanceof ApiError && !signal.aborted) error = fromStatus(err, model)
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

function fromStatus(err: ApiError, model: string): AIError {
  const said = errorText(err.message)
  if (err.status === 429) {
    return new AIError('rate-limit', "Gemini's free-tier limit was hit. Try again in a minute.")
  }
  if (err.status === 401 || (err.status === 400 && /api key/i.test(said))) {
    return new AIError('auth', 'Gemini rejected the API key.')
  }
  // 403 is also "not available where you are" or "API not enabled": show Gemini's words.
  if (err.status === 403) {
    return new AIError('auth', said ? `Gemini refused: ${said}` : 'Gemini rejected the API key.')
  }
  if (err.status === 404) return new AIError('not-found', `Gemini has no model called "${model}".`)
  if (err.status >= 500) {
    return new AIError('unavailable', 'Gemini is having trouble right now. Try again later.')
  }
  return new AIError('other', said ? `Gemini said: ${said}` : `Gemini answered ${err.status}.`)
}

/** Gemini's own message from an error body like {"error":{"message":"…"}}. */
function errorText(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message
    return typeof message === 'string' ? message : ''
  } catch {
    return ''
  }
}
