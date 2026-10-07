// Keeps the local model loaded while Claude Code works (ADR-024). A cold
// model takes 8–13 s to load, or up to a minute from disk, and the first risk
// check after a quiet spell used to wait for all of it. Now the first hook
// event of a working spell starts the load, and later events keep it fresh.

export interface ModelWarmer {
  /** Claude Code did something: make sure the model is loaded. Cheap; never throws. */
  touch(): void
  /** The model or the switch changed in Settings: warm again on the next touch. */
  reset(): void
}

/** Ollama keeps the model for KEEP_WARM_FOR after each call; refresh well before that. */
export const WARM_REFRESH_MS = 4 * 60_000
/** After a failed warm-up (Ollama closed, model missing), wait this long before trying again. */
export const WARM_RETRY_MS = 60_000

export function createModelWarmer(opts: {
  warm: (model: string, signal: AbortSignal) => Promise<void>
  /** The local model to keep loaded, or null for none (see warmModel). */
  model: () => string | null
  clock?: () => number
  refreshMs?: number
  retryMs?: number
  log?: (line: string) => void
}): ModelWarmer {
  const clock = opts.clock ?? Date.now
  const refreshMs = opts.refreshMs ?? WARM_REFRESH_MS
  const retryMs = opts.retryMs ?? WARM_RETRY_MS
  let warmedAt = new Map<string, number>()
  let failedAt = new Map<string, number>()
  let running: { model: string; controller: AbortController } | null = null
  let lastProblem = ''

  return {
    touch() {
      let model: string | null
      try {
        model = opts.model()
      } catch {
        return
      }
      if (!model || running?.model === model) return
      const now = clock()
      if (now - (warmedAt.get(model) ?? -Infinity) < refreshMs) return
      if (now - (failedAt.get(model) ?? -Infinity) < retryMs) return
      // A different model was loading: that one isn't wanted any more.
      running?.controller.abort()
      const run = { model, controller: new AbortController() }
      running = run
      let pending: Promise<void>
      try {
        pending = opts.warm(model, run.controller.signal)
      } catch (err) {
        pending = Promise.reject(err)
      }
      void pending
        .then(
          () => {
            warmedAt.set(model, clock())
            failedAt.delete(model)
            lastProblem = ''
          },
          (err: unknown) => {
            if (run.controller.signal.aborted) return
            failedAt.set(model, clock())
            // Say it once, not on every retry while Ollama stays closed.
            const problem = err instanceof Error ? err.message : String(err)
            if (problem !== lastProblem) opts.log?.(`warm-up failed: ${problem}`)
            lastProblem = problem
          }
        )
        .finally(() => {
          if (running === run) running = null
        })
    },

    reset() {
      running?.controller.abort()
      running = null
      warmedAt = new Map()
      failedAt = new Map()
    }
  }
}
