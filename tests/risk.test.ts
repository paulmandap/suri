import { describe, expect, it, vi } from 'vitest'
import type { Feature } from '@shared/ai-config'
import type { RiskFlag } from '@shared/types'
import { AIError, jsonSchemaOf, type JsonRequest } from '../src/main/ai/provider'
import {
  RISK_SYSTEM,
  RISK_TIMEOUT_MS,
  cleanRiskReply,
  createRiskExplainer,
  explanationFrom,
  riskInputFrom,
  riskPrompt,
  riskReplySchema,
  type RiskInput,
  type RiskReply
} from '../src/main/ai/risk'
import type { AIRouter, RoutedResult } from '../src/main/ai/router'

const LOCAL = { provider: 'ollama' as const, model: 'qwen3.5:9b' }
const CWD = 'C:\\work\\demo'
const REPLY: RiskReply = {
  level: 'medium',
  summary: 'Deletes the dist build folder.',
  reasons: ['It can be built again.'],
  reversible: true
}
const HIGH_RULE: RiskFlag = { level: 'high', rule: 'wide-delete', reason: 'Deletes a whole drive.' }

const bash = (command: string, rule: RiskFlag | null = null, cwd = CWD): RiskInput =>
  riskInputFrom('Bash', { command }, cwd, rule)

interface Sent {
  prompt: string
  system?: string
  signal?: AbortSignal
  timeoutMs?: number
}

/** A router whose nth risk answer (1-based) comes from `answer`. Errors are thrown. */
function fakeRouter(answer: (n: number, sent: Sent) => RiskReply | Error | Promise<RiskReply>): {
  router: Pick<AIRouter, 'generateJSON'>
  sent: Sent[]
} {
  const sent: Sent[] = []
  const router = {
    async generateJSON<T>(
      feature: Feature,
      req: Omit<JsonRequest<T>, 'model'>
    ): Promise<RoutedResult<T>> {
      expect(feature).toBe('risk')
      const call = {
        prompt: req.prompt,
        system: req.system,
        signal: req.signal,
        timeoutMs: req.timeoutMs
      }
      sent.push(call)
      const value = await answer(sent.length, call)
      if (value instanceof Error) throw value
      return { value: value as T, route: LOCAL, ms: 5, redactions: 0 }
    }
  }
  return { router, sent }
}

/** A promise to settle from the test. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('riskInputFrom and riskPrompt', () => {
  it('sends a command with its tool and project folder, between markers', () => {
    const prompt = riskPrompt(bash('rm -rf ./dist'))
    expect(prompt).toBe(
      ['Tool: Bash', `Project folder: ${CWD}`, 'Command:', '<<<', 'rm -rf ./dist', '>>>'].join('\n')
    )
  })

  it("never shows the rule's verdict to the model", () => {
    const input = bash('rm -rf /', HIGH_RULE)
    expect(input.rule).toBe(HIGH_RULE)
    expect(riskPrompt(input)).not.toContain(HIGH_RULE.reason)
    expect(riskPrompt(input)).not.toContain(HIGH_RULE.rule)
  })

  it('adds a short excerpt of a file change', () => {
    const edit = riskInputFrom(
      'Edit',
      { file_path: `${CWD}\\notes.txt`, old_string: '- milk', new_string: '- milk\n- butter' },
      CWD,
      null
    )
    expect(edit.detail).toBe(`${CWD}\\notes.txt`)
    expect(edit.change).toBe('Replace:\n- milk\nWith:\n- milk\n- butter')
    expect(riskPrompt(edit)).toContain('File:\n<<<\nC:\\work\\demo\\notes.txt\n>>>\nChange:')

    const write = riskInputFrom(
      'Write',
      { file_path: 'a.txt', content: 'x'.repeat(5000) },
      CWD,
      null
    )
    expect(write.change?.length).toBeLessThan(1300)
    expect(write.change?.endsWith('…')).toBe(true)
  })

  it('cuts a long command, and sends other tools their input as JSON', () => {
    expect(bash(`echo ${'x'.repeat(5000)}`).detail).toHaveLength(2000)
    const fetch = riskInputFrom('WebFetch', { url: 'https://example.com' }, CWD, null)
    expect(fetch.detail).toBe('{"url":"https://example.com"}')
    expect(riskPrompt(fetch)).toContain('Input:')
  })
})

describe('the reply', () => {
  it('asks the model for all four fields, with the three levels', () => {
    const schema = jsonSchemaOf(riskReplySchema) as {
      properties: Record<string, { enum?: string[] }>
      required: string[]
    }
    expect(schema.required.sort()).toEqual(['level', 'reasons', 'reversible', 'summary'])
    expect(schema.properties.level?.enum).toEqual(['low', 'medium', 'high'])
  })

  it('is tidied for the card: one line, no markdown, at most three short reasons', () => {
    const cleaned = cleanRiskReply({
      level: 'high',
      summary: '  **Deletes**   everything\n on drive C.  ',
      reasons: ['- one', '', 'two', 'three', 'four'],
      reversible: false
    })
    expect(cleaned).toEqual({
      level: 'high',
      summary: 'Deletes everything on drive C.',
      reasons: ['one', 'two', 'three'],
      reversible: false
    })
    expect(cleanRiskReply({ ...REPLY, summary: 'x'.repeat(500) })?.summary).toHaveLength(200)
    expect(cleanRiskReply({ ...REPLY, summary: '   ' })).toBeNull()
  })

  it('never ends below the rule, and keeps what the model said on its own', () => {
    const low = { ...REPLY, level: 'low' as const }
    expect(explanationFrom(low, HIGH_RULE, { route: LOCAL })).toMatchObject({
      level: 'high',
      modelLevel: 'low'
    })
    expect(explanationFrom(REPLY, null, { route: LOCAL })).toMatchObject({
      level: 'medium',
      modelLevel: 'medium',
      route: LOCAL
    })
  })

  it('says when the local model answered for Gemini', () => {
    const gemini = { provider: 'gemini' as const, model: 'gemini-3.8-flash' }
    const explanation = explanationFrom(REPLY, null, {
      route: LOCAL,
      fellBackFrom: { route: gemini, kind: 'rate-limit', message: 'Too many requests.' }
    })
    expect(explanation.fellBackFrom).toEqual({ route: gemini, reason: 'rate limit' })
  })
})

describe('createRiskExplainer', () => {
  it("asks the risk route with the shared prompt and Suri's time limit", async () => {
    const { router, sent } = fakeRouter(() => REPLY)
    const input = bash('rm -rf ./dist')
    const outcome = await createRiskExplainer({ router }).explain(input)
    expect(sent).toEqual([
      {
        prompt: riskPrompt(input),
        system: RISK_SYSTEM,
        signal: undefined,
        timeoutMs: RISK_TIMEOUT_MS
      }
    ])
    expect(outcome).toEqual({
      ok: true,
      explanation: {
        level: 'medium',
        modelLevel: 'medium',
        summary: REPLY.summary,
        reasons: REPLY.reasons,
        reversible: true,
        route: LOCAL
      }
    })
  })

  it('answers the same command in the same project from its cache', async () => {
    const { router, sent } = fakeRouter(() => REPLY)
    const explainer = createRiskExplainer({ router })
    await explainer.explain(bash('rm -rf ./dist'))
    const again = await explainer.explain(bash('rm -rf ./dist'))
    expect(again.ok).toBe(true)
    expect(sent).toHaveLength(1)

    await explainer.explain(bash('rm -rf ./dist', null, 'C:\\work\\other'))
    expect(sent).toHaveLength(2)
    explainer.clear()
    await explainer.explain(bash('rm -rf ./dist'))
    expect(sent).toHaveLength(3)
  })

  it("doesn't cache an answer that was on its way when the model changed", async () => {
    const first = deferred<RiskReply>()
    const { router, sent } = fakeRouter((n) => (n === 1 ? first.promise : REPLY))
    const explainer = createRiskExplainer({ router })
    const before = explainer.explain(bash('rm -rf ./dist'))
    await tick()
    explainer.clear()
    first.resolve(REPLY)
    expect((await before).ok).toBe(true)
    await explainer.explain(bash('rm -rf ./dist'))
    expect(sent).toHaveLength(2)
  })

  it("applies each request's own rule to a cached answer", async () => {
    const { router } = fakeRouter(() => REPLY)
    const explainer = createRiskExplainer({ router })
    await explainer.explain(bash('rm -rf ./dist'))
    const outcome = await explainer.explain(bash('rm -rf ./dist', HIGH_RULE))
    expect(outcome).toMatchObject({
      ok: true,
      explanation: { level: 'high', modelLevel: 'medium' }
    })
  })

  it('asks one model at a time, oldest first', async () => {
    const first = deferred<RiskReply>()
    const { router, sent } = fakeRouter((n) => (n === 1 ? first.promise : REPLY))
    const explainer = createRiskExplainer({ router })
    const a = explainer.explain(bash('npm test'))
    const b = explainer.explain(bash('npm run build'))
    await tick()
    expect(sent.map((s) => s.prompt)).toEqual([riskPrompt(bash('npm test'))])
    first.resolve(REPLY)
    await Promise.all([a, b])
    expect(sent.map((s) => s.prompt)).toEqual([
      riskPrompt(bash('npm test')),
      riskPrompt(bash('npm run build'))
    ])
  })

  it('skips the model for a request answered while it waited', async () => {
    const first = deferred<RiskReply>()
    const { router, sent } = fakeRouter(() => first.promise)
    const explainer = createRiskExplainer({ router })
    const a = explainer.explain(bash('npm test'))
    const gone = new AbortController()
    const b = explainer.explain(bash('npm run build'), gone.signal)
    gone.abort()
    first.resolve(REPLY)
    expect((await a).ok).toBe(true)
    expect(await b).toEqual({ ok: false, reason: 'Cancelled.' })
    expect(sent).toHaveLength(1)
  })

  it('reports a failure in words for the card, and tries again next time', async () => {
    const missing = new AIError(
      'not-found',
      'Ollama doesn\'t have "qwen3.5:9b". Get it with: ollama pull qwen3.5:9b'
    )
    const { router, sent } = fakeRouter((n) => (n === 1 ? missing : REPLY))
    const log = vi.fn()
    const explainer = createRiskExplainer({ router, log })
    expect(await explainer.explain(bash('npm test'))).toEqual({
      ok: false,
      reason: missing.message
    })
    expect(log).toHaveBeenCalledWith(`risk check failed: ${missing.message}`)
    expect((await explainer.explain(bash('npm test'))).ok).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('treats an empty answer as no explanation', async () => {
    const { router } = fakeRouter(() => ({ ...REPLY, summary: ' ' }))
    expect(await createRiskExplainer({ router }).explain(bash('npm test'))).toEqual({
      ok: false,
      reason: "The model's answer was empty."
    })
  })

  it('stops quietly when the request goes away mid-answer', async () => {
    const { router } = fakeRouter(
      (_n, call) =>
        new Promise<RiskReply>((_resolve, reject) =>
          call.signal?.addEventListener('abort', () => reject(new AIError('aborted', 'Cancelled.')))
        )
    )
    const log = vi.fn()
    const gone = new AbortController()
    const outcome = createRiskExplainer({ router, log }).explain(bash('npm test'), gone.signal)
    await tick()
    gone.abort()
    expect(await outcome).toEqual({ ok: false, reason: 'Cancelled.' })
    expect(log).not.toHaveBeenCalled()
  })
})
