import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createGeminiProvider } from '../src/main/ai/gemini'
import { AIError } from '../src/main/ai/provider'

// Plain fetch to the Gemini REST API (ADR-030), with a fake fetch: no network.
// The request bodies are the ones @google/genai 2.27 sent, recorded before the
// SDK was taken out (2026-10-07), so Gemini sees no difference.

const KEY = `AIza${'k'.repeat(35)}`
const SCHEMA = z.object({ level: z.enum(['low', 'medium', 'high']), summary: z.string() })

interface Call {
  url: string
  method: string
  headers: Headers
  redirect: RequestRedirect | undefined
  body: Record<string, unknown> | undefined
}

function fakeFetch(respond: (call: Call, signal?: AbortSignal | null) => Promise<Response>): {
  fetch: typeof globalThis.fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fakeFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    }
    calls.push(call)
    return respond(call, init?.signal)
  })
  return { fetch: fakeFn as unknown as typeof globalThis.fetch, calls }
}

const json = (status: number, data: unknown): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const answer = (text: string): unknown => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }]
})
const apiError = (status: number, message: string, code: string): Response =>
  json(status, { error: { code: status, message, status: code } })

/** Never answers; ends only when the request is aborted, the way fetch does. */
const hang = (_call: Call, signal?: AbortSignal | null): Promise<Response> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

async function failure(promise: Promise<unknown>): Promise<AIError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof AIError) return err
    throw err
  }
  throw new Error('expected the call to fail')
}

const ask = (gemini: ReturnType<typeof createGeminiProvider>): Promise<unknown> =>
  gemini.generateJSON({ model: 'gemini-3.8-flash', prompt: 'x', schema: SCHEMA })

describe('createGeminiProvider', () => {
  it('asks for JSON that follows the schema, with the key in a header', async () => {
    const { fetch, calls } = fakeFetch(async () =>
      json(200, answer('{"level":"low","summary":"Lists files."}'))
    )
    const gemini = createGeminiProvider({ apiKey: () => KEY, fetch })
    const value = await gemini.generateJSON({
      model: 'gemini-3.8-flash',
      system: 'Be brief.',
      prompt: 'ls',
      schema: SCHEMA
    })
    expect(value).toEqual({ level: 'low', summary: 'Lists files.' })
    const call = calls[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toContain('/v1beta/models/gemini-3.8-flash:generateContent')
    expect(call.url).not.toContain(KEY)
    expect(call.headers.get('x-goog-api-key')).toBe(KEY)
    expect(call.redirect).toBe('manual')
    expect(call.body).toEqual({
      contents: [{ parts: [{ text: 'ls' }], role: 'user' }],
      systemInstruction: { parts: [{ text: 'Be brief.' }], role: 'user' },
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: {
            level: { type: 'string', enum: ['low', 'medium', 'high'] },
            summary: { type: 'string' }
          },
          required: ['level', 'summary'],
          additionalProperties: false
        }
      }
    })
  })

  it('leaves out a system instruction it wasn’t given, and any thinking in the answer', async () => {
    const { fetch, calls } = fakeFetch(async () =>
      json(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Let me think about ls…', thought: true },
                { text: '{"level":"low","summary":"Lists files."}' }
              ]
            }
          }
        ]
      })
    )
    expect(await ask(createGeminiProvider({ apiKey: () => KEY, fetch }))).toEqual({
      level: 'low',
      summary: 'Lists files.'
    })
    expect(calls[0]!.body).not.toHaveProperty('systemInstruction')
  })

  it('fails with bad-output when Gemini blocks the prompt and sends no answer', async () => {
    const { fetch } = fakeFetch(async () =>
      json(200, { promptFeedback: { blockReason: 'SAFETY' } })
    )
    const error = await failure(ask(createGeminiProvider({ apiKey: () => KEY, fetch })))
    expect(error.kind).toBe('bad-output')
  })

  it('talks only to Google’s Gemini API, whatever the environment says', async () => {
    const saved = { ...process.env }
    process.env['GOOGLE_GEMINI_BASE_URL'] = 'https://proxy.example/'
    process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true'
    try {
      const { fetch, calls } = fakeFetch(async () =>
        json(200, answer('{"level":"low","summary":"ok"}'))
      )
      await ask(createGeminiProvider({ apiKey: () => KEY, fetch }))
      expect(calls[0]!.url).toMatch(
        /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:generateContent/
      )
    } finally {
      process.env = saved
    }
  })

  it('fails with bad-output when the answer is not the JSON asked for', async () => {
    const { fetch } = fakeFetch(async () => json(200, answer('Sure, here you go!')))
    const error = await failure(ask(createGeminiProvider({ apiKey: () => KEY, fetch })))
    expect(error.kind).toBe('bad-output')
  })

  it.each([
    [429, 'Resource has been exhausted (e.g. check quota).', 'RESOURCE_EXHAUSTED', 'rate-limit'],
    [400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'auth'],
    [403, 'User location is not supported for the API use.', 'PERMISSION_DENIED', 'auth'],
    [404, 'models/gemini-9 is not found.', 'NOT_FOUND', 'not-found'],
    [500, 'Internal error.', 'INTERNAL', 'unavailable'],
    [400, 'Request contains an invalid argument.', 'INVALID_ARGUMENT', 'other']
  ])('turns HTTP %i (%s) into %s', async (status, message, code, kind) => {
    const { fetch, calls } = fakeFetch(async () => apiError(status, message, code))
    const error = await failure(ask(createGeminiProvider({ apiKey: () => KEY, fetch })))
    expect(error.kind).toBe(kind)
    // One call: no retries, so the router can fall back at once.
    expect(calls).toHaveLength(1)
  })

  it('shows Gemini’s own reason for a refusal or an odd error', async () => {
    const refused = fakeFetch(async () =>
      apiError(403, 'User location is not supported for the API use.', 'PERMISSION_DENIED')
    )
    const error = await failure(
      ask(createGeminiProvider({ apiKey: () => KEY, fetch: refused.fetch }))
    )
    expect(error.message).toBe('Gemini refused: User location is not supported for the API use.')
  })

  it('never puts the key in a message, even when Gemini repeats it', async () => {
    const { fetch } = fakeFetch(async () =>
      apiError(418, `Odd request with key ${KEY}.`, 'FAILED_PRECONDITION')
    )
    const error = await failure(ask(createGeminiProvider({ apiKey: () => KEY, fetch })))
    expect(error.kind).toBe('other')
    expect(error.message).not.toContain(KEY)
    expect(error.message).toContain('[key]')
  })

  it('reports offline when the network is down', async () => {
    const { fetch } = fakeFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const error = await failure(ask(createGeminiProvider({ apiKey: () => KEY, fetch })))
    expect(error.kind).toBe('offline')
  })

  it('fails at once without a key, before any network call', async () => {
    const { fetch, calls } = fakeFetch(async () => json(200, answer('{}')))
    const error = await failure(ask(createGeminiProvider({ apiKey: () => null, fetch })))
    expect(error.kind).toBe('no-key')
    expect(calls).toHaveLength(0)
  })

  it('uses a new key as soon as it is saved', async () => {
    let key = KEY
    const { fetch, calls } = fakeFetch(async () =>
      json(200, answer('{"level":"low","summary":"ok"}'))
    )
    const gemini = createGeminiProvider({ apiKey: () => key, fetch })
    await ask(gemini)
    key = `AIza${'n'.repeat(35)}`
    await ask(gemini)
    expect(calls.map((call) => call.headers.get('x-goog-api-key'))).toEqual([KEY, key])
  })

  it('gives up after its time limit, and tells a cancel apart', async () => {
    const { fetch } = fakeFetch(hang)
    const gemini = createGeminiProvider({ apiKey: () => KEY, fetch })
    const slow = await failure(
      gemini.generateJSON({ model: 'gemini-3.8-flash', prompt: 'x', schema: SCHEMA, timeoutMs: 50 })
    )
    expect(slow.kind).toBe('timeout')

    const cancel = new AbortController()
    setTimeout(() => cancel.abort(), 30)
    const cancelled = await failure(
      gemini.generateJSON({
        model: 'gemini-3.8-flash',
        prompt: 'x',
        schema: SCHEMA,
        signal: cancel.signal
      })
    )
    expect(cancelled.kind).toBe('aborted')
  })

  it('streams text from server-sent events split across chunks', async () => {
    const events = [
      `data: ${JSON.stringify(answer('Hel'))}\n\n`,
      `data: ${JSON.stringify(answer('lo'))}\n\n`
    ].join('')
    const cut = Math.floor(events.length / 3)
    const { fetch, calls } = fakeFetch(async () => {
      const bytes = new TextEncoder().encode(events)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut))
          controller.enqueue(bytes.slice(cut))
          controller.close()
        }
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const gemini = createGeminiProvider({ apiKey: () => KEY, fetch })
    const pieces: string[] = []
    const text = await gemini.streamText({
      model: 'gemini-3.8-flash',
      prompt: 'say hello',
      onText: (piece) => pieces.push(piece)
    })
    expect(text).toBe('Hello')
    expect(pieces).toEqual(['Hel', 'lo'])
    expect(calls[0]!.url).toMatch(/\/models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/)
    expect(calls[0]!.body).toEqual({
      contents: [{ parts: [{ text: 'say hello' }], role: 'user' }],
      generationConfig: {}
    })
  })

  it('reads Windows line endings, and stops on an error sent mid-stream', async () => {
    const stream = (events: string): Promise<Response> =>
      Promise.resolve(
        new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
    const crlf = fakeFetch(() => stream(`data: ${JSON.stringify(answer('Hi'))}\r\n\r\n`))
    expect(
      await createGeminiProvider({ apiKey: () => KEY, fetch: crlf.fetch }).streamText({
        model: 'gemini-3.8-flash',
        prompt: 'x'
      })
    ).toBe('Hi')

    const broken = fakeFetch(() =>
      stream(
        `data: ${JSON.stringify(answer('Hal'))}\n\n` +
          `data: ${JSON.stringify({ error: { code: 503, message: 'The model is overloaded.' } })}\n\n`
      )
    )
    const error = await failure(
      createGeminiProvider({ apiKey: () => KEY, fetch: broken.fetch }).streamText({
        model: 'gemini-3.8-flash',
        prompt: 'x'
      })
    )
    expect(error).toMatchObject({
      kind: 'unavailable',
      message: 'Gemini stopped: The model is overloaded.'
    })
  })

  it('lists only Gemini models that can generate text', async () => {
    const { fetch } = fakeFetch(async () =>
      json(200, {
        models: [
          { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/imagen-4', supportedGenerationMethods: ['generateContent'] },
          {
            name: 'models/gemini-2.5-flash',
            supportedGenerationMethods: ['generateContent', 'countTokens']
          }
        ]
      })
    )
    const gemini = createGeminiProvider({ apiKey: () => KEY, fetch })
    expect(await gemini.listModels()).toEqual(['gemini-2.5-flash', 'gemini-3.8-flash'])
    expect(await gemini.test()).toEqual({
      ok: true,
      detail: 'Key works · 2 models',
      models: ['gemini-2.5-flash', 'gemini-3.8-flash']
    })
  })

  it('follows the pages of the model list', async () => {
    const { fetch, calls } = fakeFetch(async (call) =>
      json(
        200,
        call.url.includes('pageToken=next')
          ? {
              models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }]
            }
          : {
              models: [
                { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }
              ],
              nextPageToken: 'next'
            }
      )
    )
    const gemini = createGeminiProvider({ apiKey: () => KEY, fetch })
    expect(await gemini.listModels()).toEqual(['gemini-a', 'gemini-b'])
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100'],
      ['GET', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&pageToken=next']
    ])
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe(KEY)
  })

  it('reports a failed test without throwing', async () => {
    const { fetch } = fakeFetch(async () =>
      apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT')
    )
    const gemini = createGeminiProvider({ apiKey: () => KEY, fetch })
    expect(await gemini.test()).toEqual({
      ok: false,
      kind: 'auth',
      message: 'Gemini rejected the API key.'
    })
    expect(await createGeminiProvider({ apiKey: () => null, fetch }).test()).toMatchObject({
      ok: false,
      kind: 'no-key'
    })
  })
})
