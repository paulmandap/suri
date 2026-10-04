import type { IslandSnapshot, Session } from './types'

export type IslandMode = 'hidden' | 'peek' | 'compact' | 'expanded' | 'card'
export type CardKind = 'waiting' | 'error' | 'finished'

export interface IslandUiState {
  /** The pointer has rested over the island (or the top-centre hot zone). */
  hovering: boolean
  /** Opened on purpose: a click, the tray, or a second launch. */
  pinnedOpen: boolean
  /** Cards the user closed, by cardKey. */
  dismissed: Record<string, true>
}

export interface IslandView {
  mode: IslandMode
  card?: { kind: CardKind; session: Session }
  /** The session the compact bar talks about. */
  focus?: Session
}

/** How long finished and error cards stay up on their own. */
export const CARD_TTL_MS = 8_000

/** Identifies one card occurrence, so closing it doesn't hide the next one. */
export function cardKey(kind: CardKind, session: Session): string {
  const at =
    kind === 'waiting'
      ? session.pendingPermission?.at
      : kind === 'error'
        ? session.failedAt
        : session.finishedAt
  return `${kind}:${session.id}:${at ?? 0}`
}

/**
 * Decides what the island shows. Pure, so the whole decision table is unit
 * tested. Order matters: something waiting on Paul wins over everything.
 */
export function deriveIslandView(
  snapshot: IslandSnapshot | null,
  ui: IslandUiState,
  now: number
): IslandView {
  if (!snapshot) return { mode: 'hidden' }
  if (snapshot.paused) return { mode: ui.hovering || ui.pinnedOpen ? 'peek' : 'hidden' }

  const sessions = snapshot.sessions
  // A broken hook server must be visible, or Paul would never notice.
  if (snapshot.hookServer.state === 'error' && sessions.length === 0) {
    return { mode: ui.pinnedOpen ? 'expanded' : 'peek' }
  }

  const isOpen = (kind: CardKind, s: Session): boolean => !ui.dismissed[cardKey(kind, s)]
  const fresh = (at: number | undefined): boolean => at !== undefined && now - at < CARD_TTL_MS

  const waiting = sessions.find(
    (s) => s.status === 'waiting' && s.pendingPermission !== undefined && isOpen('waiting', s)
  )
  if (waiting) return { mode: 'card', card: { kind: 'waiting', session: waiting }, focus: waiting }

  const focus = sessions[0]
  if (ui.pinnedOpen) return { mode: 'expanded', focus }

  const failed = sessions.find(
    (s) => s.status === 'error' && fresh(s.failedAt) && isOpen('error', s)
  )
  if (failed) return { mode: 'card', card: { kind: 'error', session: failed }, focus: failed }

  const finished = sessions
    .filter((s) => s.status === 'done' && fresh(s.finishedAt) && isOpen('finished', s))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
  if (finished) {
    return { mode: 'card', card: { kind: 'finished', session: finished }, focus: finished }
  }

  if (ui.hovering) return { mode: sessions.length > 0 ? 'expanded' : 'peek', focus }
  if (sessions.length > 0) return { mode: 'compact', focus }
  return { mode: 'hidden' }
}
