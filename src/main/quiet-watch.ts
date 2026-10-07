import { quietLabel, quietReason, type ForegroundInfo } from '@shared/quiet'

// Whether Suri stays out of the way right now (ADR-029). While a full-screen
// game or app is in front, main hides the island, holds the AI work and frees
// the graphics card; when it's gone, the island comes back with whatever
// waited, and chirps.

export interface QuietWatch {
  /** Suri is staying out of the way right now. */
  quiet(): boolean
  /** Why, while quiet (for the tray), e.g. "dota2.exe is full screen". */
  label(): string | null
  /** Looks now: a hook event came in, or the setting changed. Cheap; never throws. */
  refresh(): void
  /** Resolves once Suri may show itself (at once when it may now), or when the signal aborts. */
  whenLoud(signal?: AbortSignal): Promise<void>
  onChange(listener: (quiet: boolean) => void): () => void
  stop(): void
}

/** How often Suri looks while it could show something. One look takes about 0.1 ms. */
export const QUIET_POLL_MS = 1000
/** How long the game must be gone before Suri comes back, so a quick Alt+Tab doesn't pop it up. */
export const QUIET_LEAVE_MS = 1000

export function createQuietWatch(opts: {
  /** Asks Windows about the window in front (foreground.ts); null when it can't. */
  probe: (() => ForegroundInfo | null) | null
  /** Settings → General → "Stay out of full-screen games". */
  enabled: () => boolean
  /** Something could show (a session, a request): only then is it worth looking every second. */
  active: () => boolean
  clock?: () => number
  pollMs?: number
  leaveMs?: number
  log?: (line: string) => void
}): QuietWatch {
  const clock = opts.clock ?? Date.now
  const pollMs = opts.pollMs ?? QUIET_POLL_MS
  const leaveMs = opts.leaveMs ?? QUIET_LEAVE_MS
  const listeners = new Set<(quiet: boolean) => void>()
  let quiet = false
  let label: string | null = null
  /** While quiet: when the screen was first seen clear. */
  let clearSince: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiters: (() => void)[] = []
  let stopped = false
  let failed = false

  const canLook = (): boolean => opts.probe !== null && opts.enabled()

  /** What's in front right now, as a label, or null when Suri may show itself. */
  const look = (): string | null => {
    if (!opts.probe || !opts.enabled()) return null
    try {
      const info = opts.probe()
      const reason = quietReason(info)
      return reason ? quietLabel(reason, info?.window?.exe ?? '') : null
    } catch (err) {
      // Say it once. Suri then shows itself as it always did.
      if (!failed) opts.log?.(`full-screen check failed: ${messageOf(err)}`)
      failed = true
      return null
    }
  }

  const set = (next: boolean): void => {
    quiet = next
    if (!next) {
      label = null
      clearSince = null
      const ready = waiters
      waiters = []
      for (const resolve of ready) resolve()
    }
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (err) {
        opts.log?.(`quiet listener failed: ${messageOf(err)}`)
      }
    }
  }

  const schedule = (): void => {
    if (timer || stopped) return
    // Nothing to show and nothing to come back from: no timer at all.
    if (!quiet && !(canLook() && opts.active())) return
    timer = setTimeout(() => {
      timer = null
      refresh()
    }, pollMs)
  }

  const refresh = (): void => {
    if (stopped) return
    const found = look()
    if (found) {
      clearSince = null
      if (!quiet) opts.log?.(`staying quiet: ${found}`)
      label = found
      if (!quiet) set(true)
    } else if (quiet) {
      const now = clock()
      clearSince ??= now
      // Switched off: back at once. Otherwise only once the screen stayed clear.
      if (!canLook() || now - clearSince >= leaveMs) {
        opts.log?.('back: nothing full screen in front')
        set(false)
      }
    }
    schedule()
  }

  return {
    quiet: () => quiet,
    label: () => label,
    refresh,
    whenLoud(signal) {
      if (!quiet || signal?.aborted) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const done = (): void => {
          signal?.removeEventListener('abort', done)
          waiters = waiters.filter((waiter) => waiter !== done)
          resolve()
        }
        waiters.push(done)
        signal?.addEventListener('abort', done, { once: true })
      })
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      const ready = waiters
      waiters = []
      for (const resolve of ready) resolve()
    }
  }
}

/**
 * Runs `task` only while Suri may show itself: it waits out a full-screen
 * game, and a game that comes to the front mid-task stops it, to run again
 * once the game is gone. Null when `signal` aborts first.
 */
export async function whileLoud<T>(
  watch: Pick<QuietWatch, 'whenLoud' | 'onChange' | 'quiet'>,
  signal: AbortSignal,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T | null> {
  for (;;) {
    await watch.whenLoud(signal)
    if (signal.aborted) return null
    // Another game came to the front before this got its turn.
    if (watch.quiet()) continue
    const run = new AbortController()
    const stop = (): void => run.abort()
    const off = watch.onChange((quiet) => {
      if (quiet) stop()
    })
    signal.addEventListener('abort', stop, { once: true })
    try {
      const result = await task(run.signal)
      if (signal.aborted) return null
      if (!run.signal.aborted) return result
    } finally {
      off()
      signal.removeEventListener('abort', stop)
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
