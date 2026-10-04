import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { formatElapsed, headline, moodFor, statsLabel } from '../src/renderer/src/lib/format'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    cwd: 'C:\\work\\demo',
    project: 'demo',
    status: 'thinking',
    startedAt: 0,
    lastEventAt: 0,
    running: [],
    recent: [],
    stats: { tools: 0, edits: 0, linesAdded: 0, linesRemoved: 0 },
    subagents: 0,
    ...overrides
  }
}

describe('formatElapsed', () => {
  it('reads like a clock', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(59_999)).toBe('59s')
    expect(formatElapsed(61_000)).toBe('1m')
    expect(formatElapsed(3_720_000)).toBe('1h 2m')
    expect(formatElapsed(-5)).toBe('0s')
  })
})

describe('headline', () => {
  it('says what the session is doing right now', () => {
    expect(headline(session())).toBe('Thinking…')
    expect(headline(session({ prompt: 'fix the tests' }))).toBe('Thinking about “fix the tests”')
    const running = {
      id: 'a',
      tool: 'Bash',
      kind: 'shell' as const,
      verb: 'Running',
      target: 'npm test',
      status: 'running' as const,
      startedAt: 0
    }
    expect(headline(session({ status: 'working', running: [running] }))).toBe('Running npm test')
    expect(
      headline(
        session({
          status: 'waiting',
          pendingPermission: { tool: 'Bash', target: 'git push', at: 0 }
        })
      )
    ).toBe('Needs permission · git push')
    expect(headline(session({ status: 'done', lastMessage: 'All green.' }))).toBe('All green.')
    expect(headline(session({ status: 'error' }))).toBe('Stopped with an error')
  })
})

describe('moods and stats', () => {
  it('maps every status to a mascot mood', () => {
    expect(moodFor('working')).toBe('working')
    expect(moodFor('waiting')).toBe('alert')
    expect(moodFor('done')).toBe('happy')
    expect(moodFor('error')).toBe('worried')
    expect(moodFor(undefined)).toBe('sleepy')
  })

  it('summarises the work', () => {
    expect(
      statsLabel(session({ stats: { tools: 1, edits: 0, linesAdded: 0, linesRemoved: 0 } }))
    ).toBe('1 step')
    expect(
      statsLabel(session({ stats: { tools: 3, edits: 2, linesAdded: 5, linesRemoved: 1 } }))
    ).toBe('3 steps · 2 edits +5 −1')
  })
})
