import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_AI, type AiSettings, type ProviderId } from '@shared/ai-config'
import { AIError, type AIProvider } from '../src/main/ai/provider'
import { createAIRouter } from '../src/main/ai/router'

const SCHEMA = z.object({ ok: z.boolean() })
const TOKEN = 'a'.repeat(64)
const ANTHROPIC_KEY = `sk-ant-api03-${'x'.repeat(40)}`

interface Fake extends AIProvider {
  sent: { model: string; prompt: string; system?: string }[]
}

/**
 * A provider that records what it was sent. `answer` returns the value for
 * the nth call (1-based), or an Error to throw. `chunks` are streamed first.
 */
function fake(id: ProviderId, answer: (n: number) => unknown, chunks: string[] = []): Fake {
  const sent: Fake['sent'] = []
  const settle = <T>(): T => {
    const result = answer(sent.length)
    if (result instanceof Error) throw result
    return result as T
  }
  return {
    id,
    sent,
    async generateJSON(req) {
      sent.push({ model: req.model, prompt: req.prompt, system: req.system })
      return settle()
    },
    async streamText(req) {
      sent.push({ model: req.model, prompt: req.prompt, system: req.system })
      for (const chunk of chunks) req.onText?.(chunk)
      settle()
      return chunks.join('')
    },
    listModels: async () => [],
    test: async () => ({ ok: true, detail: '', models: [] })
  }
}

function router(
  ollama: Fake,
  gemini: Fake,
  settings: () => AiSettings = () => DEFAULT_AI,
  clock?: () => number
): ReturnType<typeof createAIRouter> {
  return createAIRouter({ settings, providers: { ollama, gemini }, secrets: () => [TOKEN], clock })
}

const failWith = (kind: ConstructorParameters<typeof AIError>[0]): Error =>
  new AIError(kind, `failed: ${kind}`)

describe('createAIRouter', () => {
  it('sends a local feature to Ollama only, exactly as written', async () => {
    const ollama = fake('ollama', () => ({ ok: true }))
    const gemini = fake('gemini', () => ({ ok: true }))
    const result = await router(ollama, gemini).generateJSON('risk', {
      prompt: `token ${TOKEN}`,
      schema: SCHEMA
    })
    expect(result).toMatchObject({
      value: { ok: true },
      route: { provider: 'ollama', model: 'qwen3.5:9b' },
      redactions: 0
    })
    expect(ollama.sent[0]?.prompt).toBe(`token ${TOKEN}`)
    expect(gemini.sent).toHaveLength(0)
  })

  it('takes secrets out of everything bound for Gemini', async () => {
    const ollama = fake('ollama', () => ({ ok: true }))
    const gemini = fake('gemini', () => ({ ok: true }))
    const result = await router(ollama, gemini).generateJSON('fileQa', {
      system: `Suri token ${TOKEN}`,
      prompt: `key ${ANTHROPIC_KEY} and token ${TOKEN}`,
      schema: SCHEMA
    })
    expect(result.route).toEqual({ provider: 'gemini', model: 'gemini-3.8-flash' })
    expect(result.redactions).toBe(3)
    const sent = JSON.stringify(gemini.sent)
    expect(sent).not.toContain(TOKEN)
    expect(sent).not.toContain(ANTHROPIC_KEY)
  })

  it.each(['rate-limit', 'offline', 'no-key', 'bad-output'] as const)(
    'lets the local model answer when Gemini fails with %s',
    async (kind) => {
      const ollama = fake('ollama', () => ({ ok: true }))
      const gemini = fake('gemini', () => failWith(kind))
      const result = await router(ollama, gemini).generateJSON('digest', {
        prompt: `token ${TOKEN}`,
        schema: SCHEMA
      })
      expect(result.route).toEqual({ provider: 'ollama', model: 'qwen3.5:9b' })
      expect(result.fellBackFrom).toEqual({
        route: { provider: 'gemini', model: 'gemini-3.8-flash' },
        kind,
        message: `failed: ${kind}`
      })
      // The local model gets the text as written: it never leaves this PC.
      expect(ollama.sent[0]?.prompt).toBe(`token ${TOKEN}`)
      expect(result.redactions).toBe(0)
    }
  )

  it('asks for a prompt per model, so the fallback never gets Gemini’s long one', async () => {
    const ollama = fake('ollama', () => ({ ok: true }))
    const gemini = fake('gemini', () => failWith('rate-limit'))
    const asked: string[] = []
    const result = await router(ollama, gemini).generateJSON('fileQa', {
      prompt: 'unused',
      promptFor: (route) => {
        asked.push(route.provider)
        return route.provider === 'gemini' ? `whole document with ${TOKEN}` : 'the best chunks only'
      },
      schema: SCHEMA
    })
    expect(asked).toEqual(['gemini', 'ollama'])
    // Redaction still runs on the prompt bound for the cloud.
    expect(gemini.sent[0]?.prompt).toBe('whole document with [REDACTED]')
    expect(ollama.sent[0]?.prompt).toBe('the best chunks only')
    expect(result.fellBackFrom?.kind).toBe('rate-limit')
  })

  it('stops at a cancel instead of falling back', async () => {
    const ollama = fake('ollama', () => ({ ok: true }))
    const gemini = fake('gemini', () => failWith('aborted'))
    await expect(
      router(ollama, gemini).generateJSON('digest', { prompt: 'x', schema: SCHEMA })
    ).rejects.toMatchObject({ kind: 'aborted' })
    expect(ollama.sent).toHaveLength(0)

    const cancel = new AbortController()
    cancel.abort()
    const failing = fake('gemini', () => new Error('socket hang up'))
    await expect(
      router(ollama, failing).generateJSON('digest', {
        prompt: 'x',
        schema: SCHEMA,
        signal: cancel.signal
      })
    ).rejects.toMatchObject({ kind: 'aborted' })
  })

  it("reports the local model's failure when both fail", async () => {
    const ollama = fake('ollama', () => failWith('not-found'))
    const gemini = fake('gemini', () => failWith('rate-limit'))
    await expect(
      router(ollama, gemini).generateJSON('fileQa', { prompt: 'x', schema: SCHEMA })
    ).rejects.toMatchObject({ kind: 'not-found' })
  })

  it('never sends a local feature to the cloud, even when Ollama fails', async () => {
    const ollama = fake('ollama', () => failWith('offline'))
    const gemini = fake('gemini', () => ({ ok: true }))
    await expect(
      router(ollama, gemini).generateJSON('recap', { prompt: 'x', schema: SCHEMA })
    ).rejects.toMatchObject({ kind: 'offline' })
    expect(gemini.sent).toHaveLength(0)
  })

  it('turns a stray error into an AIError', async () => {
    const ollama = fake('ollama', () => new Error('boom'))
    const gemini = fake('gemini', () => ({ ok: true }))
    await expect(
      router(ollama, gemini).generateJSON('risk', { prompt: 'x', schema: SCHEMA })
    ).rejects.toMatchObject({ kind: 'other', message: 'boom' })
  })

  it('falls back on a stream only before any text was shown', async () => {
    const before = fake('gemini', () => failWith('rate-limit'))
    const local = fake('ollama', () => 'ok', ['Hi', ' there'])
    const pieces: string[] = []
    const result = await router(local, before).streamText('digest', {
      prompt: 'x',
      onText: (piece) => pieces.push(piece)
    })
    expect(result.route.provider).toBe('ollama')
    expect(pieces).toEqual(['Hi', ' there'])

    const midway = fake('gemini', () => failWith('offline'), ['Half an answer'])
    const unused = fake('ollama', () => 'ok', ['Hi'])
    await expect(
      router(unused, midway).streamText('digest', { prompt: 'x', onText: () => {} })
    ).rejects.toMatchObject({ kind: 'offline' })
    expect(unused.sent).toHaveLength(0)
  })

  it('reads the settings on every call', async () => {
    const ollama = fake('ollama', () => ({ ok: true }))
    const gemini = fake('gemini', () => ({ ok: true }))
    let ai: AiSettings = DEFAULT_AI
    const route = router(ollama, gemini, () => ai)
    await route.generateJSON('risk', { prompt: 'x', schema: SCHEMA })
    ai = {
      ...DEFAULT_AI,
      routes: { ...DEFAULT_AI.routes, risk: { provider: 'gemini', model: 'gemini-2.5-flash' } }
    }
    const result = await route.generateJSON('risk', { prompt: 'x', schema: SCHEMA })
    expect(result.route).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' })
  })

  it('times only the attempt that answered', async () => {
    const times = [0, 100, 350]
    const ollama = fake('ollama', () => ({ ok: true }))
    const gemini = fake('gemini', () => failWith('rate-limit'))
    const result = await router(
      ollama,
      gemini,
      () => DEFAULT_AI,
      () => times.shift() ?? 0
    ).generateJSON('fileQa', { prompt: 'x', schema: SCHEMA })
    expect(result.ms).toBe(250)
  })
})
