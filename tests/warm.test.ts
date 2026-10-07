import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AI, applyAiPatch, warmModel } from '@shared/ai-config'
import { WARM_REFRESH_MS, WARM_RETRY_MS, createModelWarmer } from '../src/main/ai/warm'
import { ensureOllama, findOllamaApp } from '../src/main/ollama-app'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('warmModel', () => {
  it("keeps the risk check's model ready, else the recap's, and nothing when switched off", () => {
    expect(warmModel(DEFAULT_AI)).toBe('qwen3.5:9b')
    const gemini = { provider: 'gemini' as const, model: 'gemini-3.8-flash' }
    const recapOnly = { ...DEFAULT_AI, routes: { ...DEFAULT_AI.routes, risk: gemini } }
    expect(warmModel(recapOnly)).toBe('qwen3.5:9b')
    expect(warmModel({ ...recapOnly, routes: { ...recapOnly.routes, recap: gemini } })).toBeNull()
    expect(warmModel(applyAiPatch(DEFAULT_AI, { keepWarm: false }))).toBeNull()
  })
})

describe('createModelWarmer', () => {
  function setup(model: () => string | null = () => 'qwen3.5:9b'): {
    warmer: ReturnType<typeof createModelWarmer>
    calls: { model: string; signal: AbortSignal; done: ReturnType<typeof deferred> }[]
    logs: string[]
    advance: (ms: number) => void
  } {
    let now = 1_000_000
    const calls: { model: string; signal: AbortSignal; done: ReturnType<typeof deferred> }[] = []
    const logs: string[] = []
    const warmer = createModelWarmer({
      warm: (m, signal) => {
        const done = deferred()
        calls.push({ model: m, signal, done })
        return done.promise
      },
      model,
      clock: () => now,
      log: (line) => logs.push(line)
    })
    return { warmer, calls, logs, advance: (ms) => (now += ms) }
  }

  it('loads the model on the first event, then only every few minutes', async () => {
    const { warmer, calls, advance } = setup()
    warmer.touch()
    warmer.touch()
    expect(calls).toHaveLength(1)
    calls[0]!.done.resolve()
    await tick()
    advance(WARM_REFRESH_MS - 1)
    warmer.touch()
    expect(calls).toHaveLength(1)
    advance(1)
    warmer.touch()
    expect(calls).toHaveLength(2)
  })

  it('waits a minute after a failure, and says so once', async () => {
    const { warmer, calls, logs, advance } = setup()
    warmer.touch()
    calls[0]!.done.reject(new Error("Can't reach Ollama. Is it running?"))
    await tick()
    warmer.touch()
    expect(calls).toHaveLength(1)
    advance(WARM_RETRY_MS)
    warmer.touch()
    calls[1]!.done.reject(new Error("Can't reach Ollama. Is it running?"))
    await tick()
    expect(calls).toHaveLength(2)
    expect(logs).toEqual(["warm-up failed: Can't reach Ollama. Is it running?"])
  })

  it('does nothing when no local model is wanted, and starts over after a change', async () => {
    let wanted: string | null = null
    const { warmer, calls } = setup(() => wanted)
    warmer.touch()
    expect(calls).toHaveLength(0)
    wanted = 'qwen3.5:9b'
    warmer.touch()
    wanted = 'qwen2.5:7b-instruct'
    warmer.touch()
    // The first model isn't wanted any more: its load is dropped.
    expect(calls.map((c) => [c.model, c.signal.aborted])).toEqual([
      ['qwen3.5:9b', true],
      ['qwen2.5:7b-instruct', false]
    ])
    calls[1]!.done.resolve()
    await tick()
    warmer.reset()
    warmer.touch()
    expect(calls).toHaveLength(3)
  })

  it('never throws, even when the settings or the call do', () => {
    const throwing = createModelWarmer({
      warm: () => {
        throw new Error('boom')
      },
      model: () => 'm'
    })
    expect(() => throwing.touch()).not.toThrow()
    const badSettings = createModelWarmer({
      warm: () => Promise.resolve(),
      model: () => {
        throw new Error('bad')
      }
    })
    expect(() => badSettings.touch()).not.toThrow()
  })
})

describe('findOllamaApp', () => {
  const APP = join('C:\\Users\\example\\AppData\\Local', 'Programs', 'Ollama', 'ollama app.exe')

  it('finds the per-user install first', () => {
    const files = new Set([APP])
    const env = { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local', PATH: '' }
    expect(findOllamaApp(env, (p) => files.has(p))).toBe(APP)
  })

  it('else the app next to an ollama.exe on PATH, else nothing', () => {
    const custom = join('D:\\Tools\\Ollama', 'ollama app.exe')
    const files = new Set([join('D:\\Tools\\Ollama', 'ollama.exe'), custom])
    const env = { LOCALAPPDATA: 'C:\\nowhere', PATH: 'C:\\Windows;D:\\Tools\\Ollama' }
    expect(findOllamaApp(env, (p) => files.has(p))).toBe(custom)
    expect(findOllamaApp({ PATH: 'C:\\Windows' }, () => false)).toBeNull()
  })
})

describe('ensureOllama', () => {
  const sleep = (): Promise<void> => Promise.resolve()

  it("leaves a running Ollama alone, and doesn't start one that isn't installed", async () => {
    const launched: string[] = []
    const launch = async (app: string): Promise<null> => {
      launched.push(app)
      return null
    }
    expect(
      await ensureOllama({ reachable: async () => true, find: () => 'app', launch, sleep })
    ).toEqual({ state: 'running' })
    expect(
      await ensureOllama({ reachable: async () => false, find: () => null, launch, sleep })
    ).toEqual({ state: 'not-installed' })
    expect(launched).toEqual([])
  })

  it('starts the app and waits until Ollama answers', async () => {
    let up = false
    let checks = 0
    const started = await ensureOllama({
      reachable: async () => {
        checks++
        if (checks === 4) up = true
        return up
      },
      find: () => 'C:\\Ollama\\ollama app.exe',
      launch: async () => null,
      sleep
    })
    expect(started).toEqual({ state: 'started' })
    expect(checks).toBe(4)
  })

  it('reports a launch that fails, or a server that never answers', async () => {
    expect(
      await ensureOllama({
        reachable: async () => false,
        find: () => 'app',
        launch: async () => 'Access is denied.',
        sleep
      })
    ).toEqual({ state: 'failed', message: "Ollama didn't start: Access is denied." })
    expect(
      await ensureOllama({
        reachable: async () => {
          throw new Error('network')
        },
        find: () => 'app',
        launch: async () => null,
        sleep,
        waitMs: 2000
      })
    ).toMatchObject({ state: 'failed', message: expect.stringMatching(/didn't answer/) })
  })
})
