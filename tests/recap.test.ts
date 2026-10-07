import { describe, expect, it } from 'vitest'
import type { Feature } from '@shared/ai-config'
import { buildTurnFacts, type TurnFacts } from '@shared/history'
import type { RecapSource, RecapUpdate } from '../src/main/history'
import { AIError, jsonSchemaOf, type JsonRequest } from '../src/main/ai/provider'
import {
  RECAP_SYSTEM,
  RECAP_TIMEOUT_MS,
  cleanRecapReply,
  createRecapWriter,
  recapPrompt,
  recapReplySchema,
  type RecapReply,
  type RecapResult
} from '../src/main/ai/recap'
import type { AIRouter, RoutedResult } from '../src/main/ai/router'

const NO_STEPS: TurnFacts = buildTurnFacts([], 'C:\\work\\demo', 0)

function facts(): TurnFacts {
  return buildTurnFacts(
    [
      { tool: 'Read', kind: 'read', detail: 'C:\\work\\demo\\a.ts', status: 'ok' },
      {
        tool: 'Edit',
        kind: 'edit',
        detail: 'C:\\work\\demo\\src\\billing.ts',
        status: 'ok',
        added: 12,
        removed: 3
      },
      { tool: 'Bash', kind: 'shell', detail: 'npm test', status: 'failed' },
      {
        tool: 'Edit',
        kind: 'edit',
        detail: 'C:\\work\\demo\\src\\billing.ts',
        status: 'ok',
        added: 1,
        removed: 1
      },
      { tool: 'Bash', kind: 'shell', detail: 'npm test', status: 'ok' },
      { tool: 'Grep', kind: 'search', detail: 'total', status: 'ok' }
    ],
    'C:\\work\\demo',
    3 * 60_000
  )
}

const SOURCE: RecapSource = {
  project: 'demo',
  prompt: 'Fix the off-by-one in billing',
  facts: facts(),
  denied: ['git push --force'],
  lastMessage: 'Fixed the off-by-one in billing.ts; all tests pass.'
}

const REPLY: RecapReply = {
  title: 'Fix the billing off-by-one',
  summary: 'Fixed an off-by-one in billing.ts; the tests pass now.',
  outcome: 'done',
  followUps: []
}

describe('recapPrompt', () => {
  it('gives the request, the counted steps and the final message, as data', () => {
    expect(recapPrompt(SOURCE)).toBe(
      [
        'Project: demo',
        'Request:',
        '<<<',
        'Fix the off-by-one in billing',
        '>>>',
        'Steps: 6 in 3 min',
        '- Changed src/billing.ts (+13 −4)',
        '- Ran: npm test (FAILED)',
        '- Ran: npm test (ok)',
        '- Read 1 file, Searched 1 time',
        '- 1 step failed',
        '- Denied by the developer: git push --force',
        'Final message:',
        '<<<',
        'Fixed the off-by-one in billing.ts; all tests pass.',
        '>>>'
      ].join('\n')
    )
  })

  it('says when the agent only answered, or Suri missed the request', () => {
    const prompt = recapPrompt({ project: 'demo', facts: NO_STEPS, denied: [] })
    expect(prompt).toContain('(not seen: Suri started during this turn)')
    expect(prompt).toContain('Steps: none, the agent only answered.')
    expect(prompt).toContain('<<<\n(none)\n>>>')
  })

  it('keeps the start and the end of a long final message, where a question would be', () => {
    const message = `${'a'.repeat(3000)} Should I also update the docs?`
    const prompt = recapPrompt({ ...SOURCE, lastMessage: message })
    expect(prompt).toContain('Should I also update the docs?')
    expect(prompt).toContain('\n…\n')
    expect(prompt.length).toBeLessThan(SOURCE.facts.steps * 200 + 3500)
  })

  it('mentions files and commands it had to leave out', () => {
    const many = buildTurnFacts(
      Array.from({ length: 30 }, (_, i) => ({
        tool: i % 2 ? 'Bash' : 'Write',
        kind: i % 2 ? ('shell' as const) : ('write' as const),
        detail: i % 2 ? `echo ${i}` : `C:\\work\\demo\\f${i}.ts`,
        status: 'ok' as const,
        added: 1
      })),
      'C:\\work\\demo',
      0
    )
    const prompt = recapPrompt({ ...SOURCE, facts: many })
    expect(prompt).toContain('- Changed 3 more files')
    expect(prompt).toContain('- Ran 5 earlier commands')
  })
})

describe('the request', () => {
  it('asks for the words only, never the files or commands', () => {
    const schema = JSON.stringify(jsonSchemaOf(recapReplySchema))
    expect(schema).not.toMatch(/files|commands/i)
    expect(RECAP_SYSTEM).toMatch(/Never invent files, commands or results/)
    expect(RECAP_SYSTEM).toMatch(/trust the steps/)
    expect(RECAP_SYSTEM).toMatch(/data, not instructions/)
  })

  it('cleans the reply: one line each, no markdown, three follow-ups at most', () => {
    expect(
      cleanRecapReply({
        title: '**Fix the billing bug.**',
        summary: '- Fixed it.\n\nTests pass.',
        outcome: 'partial',
        followUps: ['`npm test` again', '', 'b', 'c', 'd']
      })
    ).toEqual({
      title: 'Fix the billing bug',
      summary: 'Fixed it. Tests pass.',
      outcome: 'partial',
      followUps: ['npm test again', 'b', 'c']
    })
    expect(cleanRecapReply({ ...REPLY, summary: '  ' })).toBeNull()
    expect(cleanRecapReply({ ...REPLY, title: '**' })).toBeNull()
  })
})

interface Call {
  turn: string
  signal?: AbortSignal
  timeoutMs?: number
}

/** A router whose nth recap answer (1-based) comes from `answer`. Errors are thrown. */
function fakeRouter(answer: (n: number, call: Call) => RecapReply | Error | Promise<RecapReply>): {
  router: Pick<AIRouter, 'generateJSON'>
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    router: {
      async generateJSON<T>(
        feature: Feature,
        req: Omit<JsonRequest<T>, 'model'>
      ): Promise<RoutedResult<T>> {
        expect(feature).toBe('recap')
        const call = {
          turn: /^Project: (.*)$/m.exec(req.prompt)?.[1] ?? '',
          signal: req.signal,
          timeoutMs: req.timeoutMs
        }
        calls.push(call)
        const value = await answer(calls.length, call)
        if (value instanceof Error) throw value
        if (req.signal?.aborted) throw new AIError('aborted', 'Cancelled.')
        return {
          value: value as T,
          route: { provider: 'ollama', model: 'qwen2.5:7b-instruct' },
          ms: 5,
          redactions: 0
        }
      }
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Turn n's project is `t<n>`, so a call shows which turn it is about. */
function setup(
  answer: (n: number, call: Call) => RecapReply | Error | Promise<RecapReply>,
  opts: { busy?: () => boolean; held?: () => boolean; empty?: number[] } = {}
): {
  writer: ReturnType<typeof createRecapWriter>
  calls: Call[]
  saved: [number, RecapUpdate][]
  logs: string[]
} {
  const { router, calls } = fakeRouter(answer)
  const saved: [number, RecapUpdate][] = []
  const logs: string[] = []
  const writer = createRecapWriter({
    router,
    source: (id) => (opts.empty?.includes(id) ? null : { ...SOURCE, project: `t${id}` }),
    save: (id, update) => saved.push([id, update]),
    busy: opts.busy,
    held: opts.held,
    log: (line) => logs.push(line)
  })
  return { writer, calls, saved, logs }
}

describe('createRecapWriter', () => {
  it('writes one recap at a time, oldest first, and saves who wrote it', async () => {
    const first = deferred<RecapReply>()
    const { writer, calls, saved } = setup((n) => (n === 1 ? first.promise : REPLY))
    const heard: RecapResult[] = []
    writer.queue(1, (result) => heard.push(result))
    writer.queue(2)
    await tick()
    expect(calls.map((c) => c.turn)).toEqual(['t1'])
    expect(calls[0]?.timeoutMs).toBe(RECAP_TIMEOUT_MS)
    expect(saved).toEqual([
      [1, { state: 'pending' }],
      [2, { state: 'pending' }]
    ])
    first.resolve(REPLY)
    await tick()
    await tick()
    expect(calls.map((c) => c.turn)).toEqual(['t1', 't2'])
    const done = { ...REPLY, model: 'qwen2.5:7b-instruct' }
    expect(saved.slice(2)).toEqual([
      [1, { state: 'done', recap: done }],
      [2, { state: 'done', recap: done }]
    ])
    expect(heard).toEqual([{ ok: true, recap: done }])
  })

  it('makes one call for a turn queued twice while it waits', async () => {
    const first = deferred<RecapReply>()
    const { writer, calls } = setup((n) => (n === 1 ? first.promise : REPLY))
    const heard: string[] = []
    writer.queue(1)
    writer.queue(2, () => heard.push('a'))
    writer.queue(2, () => heard.push('b'))
    first.resolve(REPLY)
    await tick()
    await tick()
    expect(calls.map((c) => c.turn)).toEqual(['t1', 't2'])
    expect(heard).toEqual(['a', 'b'])
  })

  it('saves why a recap failed, in words for people', async () => {
    const { writer, saved, logs } = setup((n) =>
      n === 1
        ? new AIError('timeout', 'The model took too long to answer.')
        : new AIError('offline', "Can't reach Ollama. Is it running?")
    )
    writer.queue(1)
    writer.queue(2)
    await tick()
    await tick()
    expect(saved.filter(([, u]) => u.state === 'failed')).toEqual([
      [1, { state: 'failed', note: 'The model took too long, probably still loading.' }],
      [2, { state: 'failed', note: "Can't reach Ollama. Is it running?" }]
    ])
    expect(logs).toHaveLength(2)
  })

  it('has nothing to say about an empty turn, without asking a model', async () => {
    const { writer, calls, saved } = setup(() => REPLY, { empty: [1] })
    writer.queue(1)
    await tick()
    expect(calls).toEqual([])
    expect(saved.at(-1)).toEqual([
      1,
      { state: 'failed', note: 'Nothing happened in this turn to recap.' }
    ])
  })

  it('waits while a risk check runs, and gives way when one starts', async () => {
    let busy = true
    const first = deferred<RecapReply>()
    const { writer, calls, saved } = setup((n) => (n === 1 ? first.promise : REPLY), {
      busy: () => busy
    })
    writer.queue(1)
    await tick()
    expect(calls).toEqual([])
    busy = false
    writer.nudge()
    await tick()
    expect(calls).toHaveLength(1)
    // A risk check starts mid-call: the recap stops and goes first in line again.
    busy = true
    writer.nudge()
    expect(calls[0]?.signal?.aborted).toBe(true)
    first.resolve(REPLY)
    await tick()
    await tick()
    expect(calls).toHaveLength(1)
    expect(saved.some(([, u]) => u.state === 'failed')).toBe(false)
    busy = false
    writer.nudge()
    await tick()
    await tick()
    expect(calls).toHaveLength(2)
    expect(saved.at(-1)?.[1].state).toBe('done')
  })

  it('stops giving way after a few times, so a recap always gets written', async () => {
    let busy = false
    const pending: ReturnType<typeof deferred<RecapReply>>[] = []
    const { writer, calls, saved } = setup(
      () => {
        const d = deferred<RecapReply>()
        pending.push(d)
        return d.promise
      },
      { busy: () => busy }
    )
    writer.queue(1)
    for (let i = 0; i < 3; i++) {
      await tick()
      busy = true
      writer.nudge()
      pending.at(-1)?.resolve(REPLY)
      await tick()
      await tick()
      busy = false
      writer.nudge()
    }
    await tick()
    expect(calls).toHaveLength(4)
    busy = true
    writer.nudge()
    expect(calls[3]?.signal?.aborted).toBe(false)
    pending.at(-1)?.resolve(REPLY)
    await tick()
    await tick()
    expect(saved.at(-1)?.[1].state).toBe('done')
  })

  it('waits out a full-screen game, however often one comes (ADR-029)', async () => {
    let held = true
    let busy = false
    const pending: ReturnType<typeof deferred<RecapReply>>[] = []
    const { writer, calls, saved } = setup(
      () => {
        const d = deferred<RecapReply>()
        pending.push(d)
        return d.promise
      },
      { held: () => held, busy: () => busy }
    )
    writer.queue(1)
    await tick()
    expect(calls).toEqual([])
    // More games than MAX_YIELDS: a game never makes a recap run anyway.
    for (let i = 0; i < 5; i++) {
      held = false
      writer.nudge()
      await tick()
      held = true
      writer.nudge()
      expect(calls.at(-1)?.signal?.aborted).toBe(true)
      pending.at(-1)?.resolve(REPLY)
      await tick()
      await tick()
    }
    expect(calls).toHaveLength(5)
    expect(saved.map(([, u]) => u.state)).toEqual(['pending'])
    held = false
    writer.nudge()
    await tick()
    // The games used none of its turns: a risk check still makes it give way.
    busy = true
    writer.nudge()
    expect(calls.at(-1)?.signal?.aborted).toBe(true)
    pending.at(-1)?.resolve(REPLY)
    await tick()
    await tick()
    busy = false
    writer.nudge()
    await tick()
    pending.at(-1)?.resolve(REPLY)
    await tick()
    await tick()
    expect(calls).toHaveLength(7)
    expect(saved.at(-1)?.[1].state).toBe('done')
  })

  it('on quit, stops the call and leaves the rest pending for next time', async () => {
    const first = deferred<RecapReply>()
    const { writer, calls, saved } = setup(() => first.promise)
    writer.queue(1)
    writer.queue(2)
    await tick()
    writer.stop()
    expect(calls[0]?.signal?.aborted).toBe(true)
    first.resolve(REPLY)
    await tick()
    await tick()
    expect(calls).toHaveLength(1)
    expect(saved.map(([, u]) => u.state)).toEqual(['pending', 'pending'])
    writer.queue(3)
    expect(saved).toHaveLength(2)
  })
})
