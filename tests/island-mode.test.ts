import { describe, expect, it } from 'vitest'
import {
  CARD_TTL_MS,
  FOCUS_DWELL_MS,
  approvalLevel,
  cardKey,
  deriveIslandView,
  islandCardKey,
  pickFocus,
  quietUi,
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
    quiet: false,
    hookServer: { state: 'listening', port: 47821 },
    hooks: 'installed',
    sounds: { needsYou: true, finished: false },
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

  it("shows the rule's level at once, then the AI's combined level", () => {
    const route = { provider: 'ollama' as const, model: 'qwen3.5:9b' }
    const explained = {
      level: 'high' as const,
      modelLevel: 'high' as const,
      summary: 'Publishes the package to npm.',
      reasons: [],
      reversible: false,
      route
    }
    const rule = { level: 'medium' as const, rule: 'recursive-delete', reason: 'Deletes a folder.' }
    expect(approvalLevel(approval('a1'))).toBeUndefined()
    expect(approvalLevel({ ...approval('a1'), risk: rule })).toBe('medium')
    expect(approvalLevel({ ...approval('a1'), risk: rule, explanation: explained })).toBe('high')
    expect(approvalLevel({ ...approval('a1'), explanation: { ...explained, level: 'low' } })).toBe(
      'low'
    )
  })
})

describe('pickFocus: the compact bar stays put between two busy sessions', () => {
  const a = session({ id: 'a' })
  const b = session({ id: 'b' })

  it('starts on the most relevant session, and has none without sessions', () => {
    expect(pickFocus(undefined, [a, b], NOW)).toEqual({ id: 'a', since: NOW })
    expect(pickFocus({ id: 'a', since: 0 }, [], NOW)).toBeUndefined()
  })

  it('keeps its session while the other one moves ahead, until the dwell is over', () => {
    const focus = { id: 'a', since: NOW }
    expect(pickFocus(focus, [b, a], NOW + FOCUS_DWELL_MS - 1)).toBe(focus)
    expect(pickFocus(focus, [b, a], NOW + FOCUS_DWELL_MS)).toEqual({
      id: 'b',
      since: NOW + FOCUS_DWELL_MS
    })
    expect(pickFocus(focus, [a, b], NOW + 60_000)).toBe(focus)
  })

  it("doesn't flip between working and thinking: both are busy (seen live)", () => {
    const focus = { id: 'a', since: NOW }
    const thinkingA = session({ id: 'a', status: 'thinking' })
    const workingB = session({ id: 'b', status: 'working' })
    expect(pickFocus(focus, [workingB, thinkingA], NOW + 10)).toBe(focus)
  })

  it('lets a session that needs Paul take over at once, and a busy one beat a finished one', () => {
    const asking = session({ id: 'b', status: 'waiting' })
    expect(pickFocus({ id: 'a', since: NOW }, [asking, a], NOW + 10)).toEqual({
      id: 'b',
      since: NOW + 10
    })
    const done = session({ id: 'a', status: 'done' })
    expect(pickFocus({ id: 'a', since: NOW }, [b, done], NOW + 10)).toEqual({
      id: 'b',
      since: NOW + 10
    })
  })

  it('moves on when its session ends', () => {
    expect(pickFocus({ id: 'gone', since: NOW }, [b], NOW + 10)).toEqual({
      id: 'b',
      since: NOW + 10
    })
  })

  it('is what the compact bar shows', () => {
    const view = deriveIslandView(snapshot([b, a]), ui({ focus: { id: 'a', since: NOW } }), NOW)
    expect(view).toMatchObject({ mode: 'compact', focus: { id: 'a' } })
    const ended = deriveIslandView(snapshot([b]), ui({ focus: { id: 'a', since: NOW } }), NOW)
    expect(ended.focus?.id).toBe('b')
  })
})

describe('the file panel (ADR-027)', () => {
  const held: PendingApproval = {
    id: 'a1',
    sessionId: 's1',
    project: 'demo',
    tool: 'Bash',
    verb: 'Running',
    detail: 'npm publish',
    createdAt: NOW - 1_000,
    expiresAt: NOW + 100_000
  }

  it('stays open whatever the pointer does, even with no session or while paused', () => {
    expect(deriveIslandView(snapshot([]), ui({ askOpen: true }), NOW).mode).toBe('ask')
    expect(deriveIslandView(snapshot([session()]), ui({ askOpen: true }), NOW).mode).toBe('ask')
    expect(deriveIslandView(snapshot([], { paused: true }), ui({ askOpen: true }), NOW).mode).toBe(
      'ask'
    )
  })

  it('makes way for a request waiting on Paul, and for the Allowed flash, then comes back', () => {
    const open = ui({ askOpen: true })
    expect(deriveIslandView(snapshot([session()], { approvals: [held] }), open, NOW).mode).toBe(
      'card'
    )
    const flash = ui({ askOpen: true, feedback: { id: 'a1', decision: 'allow', project: 'demo' } })
    expect(deriveIslandView(snapshot([session()]), flash, NOW).card?.kind).toBe('feedback')
    expect(deriveIslandView(snapshot([session()]), open, NOW).mode).toBe('ask')
  })
})

describe('a full-screen game in front (ADR-029)', () => {
  const held: PendingApproval = {
    id: 'a1',
    sessionId: 's1',
    project: 'demo',
    tool: 'Bash',
    verb: 'Running',
    detail: 'npm publish',
    createdAt: NOW - 1_000,
    expiresAt: NOW + 100_000
  }

  it('shows nothing at all: no card, no panel, no hover, no broken server', () => {
    const quiet = { quiet: true }
    const views = [
      deriveIslandView(snapshot([session()], { ...quiet, approvals: [held] }), UI, NOW),
      deriveIslandView(snapshot([session()], quiet), ui({ askOpen: true, hovering: true }), NOW),
      deriveIslandView(
        snapshot([session({ finishedAt: NOW })], quiet),
        ui({ pinnedOpen: true }),
        NOW
      ),
      deriveIslandView(
        snapshot([], { ...quiet, hookServer: { state: 'error', port: 1, message: 'taken' } }),
        UI,
        NOW
      )
    ]
    expect(views.map((view) => view.mode)).toEqual(['hidden', 'hidden', 'hidden', 'hidden'])
  })

  it('brings the held request back as a fresh card once the game is gone', () => {
    const view = deriveIslandView(snapshot([session()], { approvals: [held] }), UI, NOW)
    expect(view.card?.kind).toBe('approval')
  })

  it('forgets the hover, the pin and the file panel, so nothing pops open after', () => {
    const busy = ui({ hovering: true, pinnedOpen: true, askOpen: true })
    expect(quietUi(busy)).toEqual({ ...busy, hovering: false, pinnedOpen: false, askOpen: false })
    expect(quietUi(UI)).toBe(UI)
  })
})
