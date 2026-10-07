import { createHash } from 'node:crypto'
import { AIError } from '../src/main/ai/provider'

// What the eval runners share: pacing for the Gemini free tier, retries for
// failures that say nothing about the model, and small formatting helpers.

export const MAX_RETRIES = 3

/**
 * How long to wait before trying again, or null to give up. The free tier's
 * per-minute limit and an overloaded server say nothing about the model.
 */
export function retryDelay(err: unknown, attempt: number): number | null {
  if (!(err instanceof AIError) || attempt > MAX_RETRIES) return null
  if (err.kind === 'rate-limit') return 60_000
  if (err.kind === 'unavailable' || err.kind === 'timeout' || err.kind === 'offline') {
    return 15_000 * attempt
  }
  return null
}

/** Starts calls at least `gapMs` apart: the Gemini free tier counts requests per minute. */
export function pacer(gapMs: number): () => Promise<void> {
  let last = 0
  return async () => {
    const wait = last + gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    last = Date.now()
  }
}

export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
