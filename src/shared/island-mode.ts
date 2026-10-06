import type { IslandSnapshot, PendingApproval, RiskLevel, Session } from './types'

export type IslandMode = 'hidden' | 'peek' | 'compact' | 'expanded' | 'card'
export type SessionCardKind = 'waiting' | 'error' | 'finished'

/** The short "Allowed / Denied" moment after Paul clicks, before the island folds. */
export interface DecisionFeedback {
  id: string
  decision: 'allow' | 'deny'
  project: string
}

export interface IslandUiState {
  /** The pointer has rested over the island (or the top-centre hot zone). */
  hovering: boolean
  /** Opened on purpose: a click, the tray, or a second launch. */
  pinnedOpen: boolean
  /** Cards the user closed, by cardKey. */
  dismissed: Record<string, true>
  feedback?: DecisionFeedback
}

export type IslandCard =
  | { kind: 'approval'; approval: PendingApproval; queued: number }
  | { kind: 'feedback'; feedback: DecisionFeedback }
  | { kind: SessionCardKind; session: Session }

export interface IslandView {
  mode: IslandMode
  card?: IslandCard
  /** The session the compact bar talks about. */
  focus?: Session
}

/** How long finished and error cards stay up on their own. */
export const CARD_TTL_MS = 8_000

/** Identifies one session card occurrence, so closing it doesn't hide the next one. */
export function cardKey(kind: SessionCardKind, session: Session): string {
  const at =
    kind === 'waiting'
      ? session.pendingPermission?.at
      : kind === 'error'
        ? session.failedAt
        : session.finishedAt
  return `${kind}:${session.id}:${at ?? 0}`
}

/**
 * The level an approval card shows: the AI's combined level once it answered
 * (never below the rule's, see risk.ts), else the rule's. None when neither has spoken.
 */
export function approvalLevel(approval: PendingApproval): RiskLevel | undefined {
  return approval.explanation?.level ?? approval.risk?.level
}

/** A stable key for any card, used to re-animate only when the card changes. */
export function islandCardKey(card: IslandCard): string {
  if (card.kind === 'approval') return `approval:${card.approval.id}`
  if (card.kind === 'feedback') return `feedback:${card.feedback.id}`
  return cardKey(card.kind, card.session)
}

/**
 * Decides what the island shows. Pure, so the whole decision table is unit
 * tested. Order matters: a held approval beats everything except the brief
 * feedback for the one Paul just answered.
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

  const focus = sessions[0]
  if (ui.feedback) return { mode: 'card', card: { kind: 'feedback', feedback: ui.feedback }, focus }

  const [approval, ...queued] = snapshot.approvals
  if (approval) {
    const session = sessions.find((s) => s.id === approval.sessionId) ?? focus
    return {
      mode: 'card',
      card: { kind: 'approval', approval, queued: queued.length },
      focus: session
    }
  }

  const isOpen = (kind: SessionCardKind, s: Session): boolean => !ui.dismissed[cardKey(kind, s)]
  const fresh = (at: number | undefined): boolean => at !== undefined && now - at < CARD_TTL_MS

  const waiting = sessions.find(
    (s) => s.status === 'waiting' && s.pendingPermission !== undefined && isOpen('waiting', s)
  )
  if (waiting) return { mode: 'card', card: { kind: 'waiting', session: waiting }, focus: waiting }

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
