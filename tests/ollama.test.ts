import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createOllamaProvider } from '../src/main/ai/ollama'
import { AIError, jsonSchemaOf } from '../src/main/ai/provider'

// A fake Ollama on 127.0.0.1 (loopback only, no internet), answering in the
// shapes Ollama 0.35.1 used on Paul's PC.

interface Seen {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

async function fakeOllama(
  handle: (seen: Seen, res: ServerResponse) => void
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      const call = {
        method: req.method ?? '',
        path: req.url ?? '',
        body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined
      }
      seen.push(call)
      handle(call, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

const SCHEMA = z.object({ level: z.enum(['low', 'medium', 'high']), summary: z.string() })
const chat = (content: string): unknown => ({
  model: 'qwen2.5:3b-instruct',
  message: { role: 'assistant', content },
  done: true
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

describe('createOllamaProvider', () => {
  it('sends the documented chat request and checks the reply against the schema', async () => {
    const { url, seen } = await fakeOllama((_call, res) =>
      send(res, 200, chat('{"level":"high","summary":"Deletes everything."}'))
    )
    const ollama = createOllamaProvider({ url: () => url })
    const value = await ollama.generateJSON({
      model: 'qwen2.5:3b-instruct',
      system: 'Be brief.',
      prompt: 'rm -rf /',
      schema: SCHEMA
    })
    expect(value).toEqual({ level: 'high', summary: 'Deletes everything.' })
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/api/chat',
      body: {
        model: 'qwen2.5:3b-instruct',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'rm -rf /' }
        ],
        format: jsonSchemaOf(SCHEMA),
        stream: false,
        think: false,
        options: { temperature: 0 }
      }
    })

    await ollama.generateJSON({ model: 'm', prompt: 'hi', schema: SCHEMA })
    expect(seen[1]?.body?.['messages']).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('fails with bad-output when the reply is not JSON or has the wrong shape', async () => {
    const replies = ['Sure! It is risky.', '{"level":"extreme","summary":"?"}']
    const { url } = await fakeOllama((_call, res) => send(res, 200, chat(replies.shift() ?? '')))
    const ollama = createOllamaProvider({ url: () => url })
    for (let i = 0; i < 2; i++) {
      const error = await failure(ollama.generateJSON({ model: 'm', prompt: 'x', schema: SCHEMA }))
      expect(error.kind).toBe('bad-output')
    }
  })

  it.each([
    [404, { error: "model 'qwen3.5:9b' not found" }, 'not-found', 'ollama pull qwen3.5:9b'],
    [
      400,
      { error: '"qwen2.5:3b-instruct" does not support thinking' },
      'other',
      'does not support thinking'
    ],
    [500, { error: 'out of memory' }, 'unavailable', 'out of memory']
  ])('turns HTTP %i into %s', async (status, body, kind, text) => {
    const { url } = await fakeOllama((_call, res) => send(res, status, body))
    const ollama = createOllamaProvider({ url: () => url })
    const error = await failure(
      ollama.generateJSON({ model: 'qwen3.5:9b', prompt: 'x', schema: SCHEMA })
    )
    expect(error.kind).toBe(kind)
    expect(error.message).toContain(text)
  })

  it('reports offline when nothing listens on the port', async () => {
    const { url } = await fakeOllama(() => {})
    await new Promise<void>((resolve) => {
      const server = servers.pop()!
      server.close(() => resolve())
    })
    const ollama = createOllamaProvider({ url: () => url })
    const error = await failure(ollama.generateJSON({ model: 'm', prompt: 'x', schema: SCHEMA }))
    expect(error.kind).toBe('offline')
    expect(error.message).toContain("Can't reach Ollama")
  })

  it('gives up after its time limit, and tells a cancel apart', async () => {
    const { url } = await fakeOllama(() => {})
    const ollama = createOllamaProvider({ url: () => url })
    const slow = await failure(
      ollama.generateJSON({ model: 'm', prompt: 'x', schema: SCHEMA, timeoutMs: 100 })
    )
    expect(slow.kind).toBe('timeout')

    const cancel = new AbortController()
    setTimeout(() => cancel.abort(), 50)
    const cancelled = await failure(
      ollama.generateJSON({ model: 'm', prompt: 'x', schema: SCHEMA, signal: cancel.signal })
    )
    expect(cancelled.kind).toBe('aborted')
  })

  it('never sends a prompt to an address off this PC', async () => {
    const fetch = vi.fn()
    const ollama = createOllamaProvider({
      url: () => 'http://example.com:11434',
      fetch: fetch as unknown as typeof globalThis.fetch
    })
    const error = await failure(ollama.generateJSON({ model: 'm', prompt: 'x', schema: SCHEMA }))
    expect(error.kind).toBe('other')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('streams text, even when a line arrives in pieces', async () => {
    const { url, seen } = await fakeOllama((_call, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"message":{"content":"Hel')
      setTimeout(() => {
        res.write('lo"},"done":false}\n{"message":{"content":" world"},"done":false}\n')
        setTimeout(() => res.end('{"message":{"content":""},"done":true}\n'), 10)
      }, 10)
    })
    const ollama = createOllamaProvider({ url: () => url })
    const pieces: string[] = []
    const text = await ollama.streamText({
      model: 'm',
      prompt: 'say hello',
      onText: (piece) => pieces.push(piece)
    })
    expect(text).toBe('Hello world')
    expect(pieces).toEqual(['Hello', ' world'])
    expect(seen[0]?.body).toMatchObject({ stream: true, think: false })
  })

  it('fails a stream that reports an error or stops early', async () => {
    const bodies = [
      '{"message":{"content":"Hi"},"done":false}\n{"error":"model crashed"}\n',
      '{"message":{"content":"Hi"},"done":false}\n'
    ]
    const { url } = await fakeOllama((_call, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(bodies.shift())
    })
    const ollama = createOllamaProvider({ url: () => url })
    const crashed = await failure(ollama.streamText({ model: 'm', prompt: 'x' }))
    expect(crashed).toMatchObject({ kind: 'other', message: 'model crashed' })
    const cut = await failure(ollama.streamText({ model: 'm', prompt: 'x' }))
    expect(cut.kind).toBe('unavailable')
  })

  it('lists models and tests the connection without ever throwing', async () => {
    const { url } = await fakeOllama((call, res) => {
      if (call.path === '/api/version') send(res, 200, { version: '0.35.1' })
      else send(res, 200, { models: [{ name: 'qwen2.5:7b-instruct' }, { name: 'llama3:8b' }] })
    })
    const ollama = createOllamaProvider({ url: () => url })
    expect(await ollama.listModels()).toEqual(['llama3:8b', 'qwen2.5:7b-instruct'])
    expect(await ollama.test()).toEqual({
      ok: true,
      detail: 'Ollama 0.35.1',
      models: ['llama3:8b', 'qwen2.5:7b-instruct']
    })

    const offline = createOllamaProvider({ url: () => 'http://127.0.0.1:1' })
    expect(await offline.test()).toMatchObject({ ok: false, kind: 'offline' })
  })

  it('asks Ollama to keep the model loaded, only while keep warm is on (ADR-024)', async () => {
    const { url, seen } = await fakeOllama((call, res) => {
      if (call.path === '/api/generate') send(res, 200, { done: true, done_reason: 'load' })
      else send(res, 200, chat('{"level":"low","summary":"ok"}'))
    })
    let keep: string | undefined = '15m'
    const ollama = createOllamaProvider({ url: () => url, keepAlive: () => keep })
    await ollama.generateJSON({ model: 'm', prompt: 'x', schema: SCHEMA })
    // An empty prompt only loads the model: Ollama's documented preload.
    await ollama.warm('qwen3.5:9b')
    keep = undefined
    await ollama.generateJSON({ model: 'm', prompt: 'x', schema: SCHEMA })
    expect(seen.map((call) => [call.path, call.body?.keep_alive])).toEqual([
      ['/api/chat', '15m'],
      ['/api/generate', '15m'],
      ['/api/chat', undefined]
    ])
    expect(seen[1]?.body).toEqual({ model: 'qwen3.5:9b', keep_alive: '15m' })
  })

  it('says which model is missing when a warm-up finds none', async () => {
    const { url } = await fakeOllama((_call, res) =>
      send(res, 404, { error: 'model "nope" not found, try pulling it first' })
    )
    const ollama = createOllamaProvider({ url: () => url })
    expect(await failure(ollama.warm('nope'))).toMatchObject({ kind: 'not-found' })
  })

  it('lists the models in memory and unloads one, for a full-screen game (ADR-029)', async () => {
    const { url, seen } = await fakeOllama((call, res) => {
      // /api/ps as Ollama 0.40.0 answered on Paul's PC (2026-10-07), trimmed.
      if (call.path === '/api/ps') {
        send(res, 200, {
          models: [
            {
              name: 'qwen3.5:9b',
              model: 'qwen3.5:9b',
              size: 5589560196,
              size_vram: 5589560196,
              expires_at: '2026-10-07T19:24:39.3228059+08:00',
              context_length: 4096
            }
          ]
        })
      } else send(res, 200, { model: 'qwen3.5:9b', done: true, done_reason: 'unload' })
    })
    const ollama = createOllamaProvider({ url: () => url, keepAlive: () => '15m' })
    expect(await ollama.loaded()).toEqual(['qwen3.5:9b'])
    await ollama.unload('qwen3.5:9b')
    // keep_alive 0 with no prompt: unload now, whatever keep warm says.
    expect(seen.map((call) => [call.method, call.path, call.body])).toEqual([
      ['GET', '/api/ps', undefined],
      ['POST', '/api/generate', { model: 'qwen3.5:9b', keep_alive: 0 }]
    ])
  })

  it('reports offline when Ollama is closed and nothing can be loaded', async () => {
    const ollama = createOllamaProvider({ url: () => 'http://127.0.0.1:1' })
    expect(await failure(ollama.loaded())).toMatchObject({ kind: 'offline' })
  })
})
