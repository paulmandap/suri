import type { HookEvent } from '@shared/hook-events'
import { createSessionsState, pruneSessions, reduceSessions, sortSessions } from '@shared/sessions'
import type { Session } from '@shared/types'

export interface SessionsStore {
  apply(event: HookEvent): void
  prune(maxIdleMs?: number): void
  list(): Session[]
  get(id: string): Session | undefined
  onChange(listener: () => void): () => void
}

/** Holds the session state in main; the pure reducer does the real work. */
export function createSessionsStore(clock: () => number = Date.now): SessionsStore {
  let state = createSessionsState()
  const listeners = new Set<() => void>()
  const commit = (next: typeof state): void => {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }
  return {
    apply: (event) => commit(reduceSessions(state, event, clock())),
    prune: (maxIdleMs) => commit(pruneSessions(state, clock(), maxIdleMs)),
    list: () => sortSessions(state),
    get: (id) => state.sessions[id],
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
