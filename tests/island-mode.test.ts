import { describe, expect, it } from 'vitest'
import {
  CARD_TTL_MS,
  cardKey,
  deriveIslandView,
  islandCardKey,
  type IslandUiState
} from '@shared/island-mode'
import type { IslandSnapshot, PendingApproval, Session } from '@shared/types'

const NOW = 100_000

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    cwd: 'C:\\work\\demo',
    project: 'demo',
    status: 'working',
    startedAt: NOW - 60_000,
    lastEventAt: NOW - 1_000,
    running: [],
    recent: [],
    stats: { tools: 0, edits: 0, linesAdded: 0, linesRemoved: 0 },
    subagents: 0,
    ...overrides
  }
}

function snapshot(sessions: Session[], extra: Partial<IslandSnapshot> = {}): IslandSnapshot {
  return {
    sessions,
    approvals: [],
    paused: false,
    hookServer: { state: 'listening', port: 47821 },
    hooks: 'installed',
    sentAt: NOW,
    ...extra
  }
}

const UI: IslandUiState = { hovering: false, pinnedOpen: false, dismissed: {} }
const ui = (over: Partial<IslandUiState>): IslandUiState => ({ ...UI, ...over })

describe('deriveIslandView', () => {
  it('stays hidden with nothing to show, and peeks when the pointer visits', () => {
    expect(deriveIslandView(null, UI, NOW).mode).toBe('hidden')
    expect(deriveIslandView(snapshot([]), UI, NOW).mode).toBe('hidden')
    expect(deriveIslandView(snapshot([]), ui({ hovering: true }), NOW).mode).toBe('peek')
    expect(deriveIslandView(snapshot([]), ui({ pinnedOpen: true }), NOW).mode).toBe('expanded')
  })

  it('shows a compact bar about the most relevant session', () => {
    const first = session({ id: 'a' })
    const view = deriveIslandView(snapshot([first, session({ id: 'b' })]), UI, NOW)
    expect(view.mode).toBe('compact')
    expect(view.focus).toBe(first)
  })

  it('expands on hover or on purpose', () => {
    const snap = snapshot([session()])
    expect(deriveIslandView(snap, ui({ hovering: true }), NOW).mode).toBe('expanded')
    expect(deriveIslandView(snap, ui({ pinnedOpen: true }), NOW).mode).toBe('expanded')
  })

  it('puts a waiting session above everything, even an open island', () => {
    const waiting = session({
      id: 'w',
      status: 'waiting',
      pendingPermission: { tool: 'Bash', target: 'rm -rf dist', at: NOW - 500 }
    })
    const view = deriveIslandView(snapshot([waiting]), ui({ pinnedOpen: true }), NOW)
    expect(view).toMatchObject({ mode: 'card', card: { kind: 'waiting' } })
    const closed = ui({ dismissed: { [cardKey('waiting', waiting)]: true } })
    expect(deriveIslandView(snapshot([waiting]), closed, NOW).mode).toBe('compact')
  })

  it('shows a finished card for a while, then folds back', () => {
    const done = session({ status: 'done', finishedAt: NOW - 1_000 })
    expect(deriveIslandView(snapshot([done]), UI, NOW)).toMatchObject({
      mode: 'card',
      card: { kind: 'finished' }
    })
    expect(deriveIslandView(snapshot([done]), UI, NOW + CARD_TTL_MS).mode).toBe('compact')
    // Hovering doesn't chase the card away.
    expect(deriveIslandView(snapshot([done]), ui({ hovering: true }), NOW).mode).toBe('card')
  })

  it('lets a closed card stay closed, but not the next one', () => {
    const done = session({ status: 'done', finishedAt: NOW - 1_000 })
    const closed = ui({ dismissed: { [cardKey('finished', done)]: true } })
    expect(deriveIslandView(snapshot([done]), closed, NOW).mode).toBe('compact')
    const again = { ...done, finishedAt: NOW - 10 }
    expect(deriveIslandView(snapshot([again]), closed, NOW).mode).toBe('card')
  })

  it('shows an error card before a finished one', () => {
    const done = session({ id: 'd', status: 'done', finishedAt: NOW - 500 })
    const failed = session({ id: 'e', status: 'error', failedAt: NOW - 800 })
    expect(deriveIslandView(snapshot([failed, done]), UI, NOW).card?.kind).toBe('error')
  })

  it('a click beats a finished card', () => {
    const done = session({ status: 'done', finishedAt: NOW - 1_000 })
    expect(deriveIslandView(snapshot([done]), ui({ pinnedOpen: true }), NOW).mode).toBe('expanded')
  })

  it('hides while paused, peeking only on a visit', () => {
    const snap = snapshot([session()], { paused: true })
    expect(deriveIslandView(snap, UI, NOW).mode).toBe('hidden')
    expect(deriveIslandView(snap, ui({ hovering: true }), NOW).mode).toBe('peek')
  })

  it('keeps a broken hook server visible', () => {
    const broken = snapshot([], {
      hookServer: { state: 'error', port: 47821, message: 'Port 47821 is already in use.' }
    })
    expect(deriveIslandView(broken, UI, NOW).mode).toBe('peek')
  })
})

describe('held approvals', () => {
  const approval = (id: string, sessionId = 's1'): PendingApproval => ({
    id,
    sessionId,
    project: 'demo',
    tool: 'Bash',
    verb: 'Running',
    detail: 'npm publish',
    createdAt: NOW - 1_000,
    expiresAt: NOW + 100_000
  })

  it('shows the oldest held approval above everything, with the queue count', () => {
    const waiting = session({
      status: 'waiting',
      pendingPermission: { tool: 'Bash', target: 'npm publish', at: NOW - 500 }
    })
    const view = deriveIslandView(
      snapshot([waiting], { approvals: [approval('a1'), approval('a2')] }),
      ui({ pinnedOpen: true }),
      NOW
    )
    expect(view.mode).toBe('card')
    expect(view.card).toMatchObject({ kind: 'approval', approval: { id: 'a1' }, queued: 1 })
    expect(view.focus).toBe(waiting)
  })

  it('shows the short feedback first, right after a click', () => {
    const view = deriveIslandView(
      snapshot([session()], { approvals: [approval('a2')] }),
      ui({ feedback: { id: 'a1', decision: 'allow', project: 'demo' } }),
      NOW
    )
    expect(view.card).toMatchObject({ kind: 'feedback', feedback: { decision: 'allow' } })
  })

  it('gives every card a stable key', () => {
    expect(islandCardKey({ kind: 'approval', approval: approval('a9'), queued: 0 })).toBe(
      'approval:a9'
    )
  })
})
