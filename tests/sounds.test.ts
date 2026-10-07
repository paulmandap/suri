import { describe, expect, it } from 'vitest'
import { soundFor, synthesize, type SoundCue } from '@shared/sounds'
import type { IslandSnapshot, PendingApproval, Session } from '@shared/types'

const CUES: SoundCue[] = ['needs-you', 'finished', 'error']
const RATE = 48_000

const peak = (samples: Float32Array): number =>
  samples.reduce((max, x) => Math.max(max, Math.abs(x)), 0)

describe('synthesize', () => {
  it.each(CUES)('%s is short and soft, and starts and ends in silence', (cue) => {
    const samples = synthesize(cue, RATE)
    expect(samples.length / RATE).toBeLessThan(0.5)
    expect(samples.every(Number.isFinite)).toBe(true)
    expect(peak(samples)).toBeGreaterThan(0.05)
    expect(peak(samples)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(samples[0] ?? 1)).toBeLessThan(1e-3)
    expect(Math.abs(samples[samples.length - 1] ?? 1)).toBeLessThan(1e-3)
  })

  it.each(CUES)('%s never jumps between samples, so it never clicks', (cue) => {
    const samples = synthesize(cue, RATE)
    let jump = 0
    for (let i = 1; i < samples.length; i++) {
      jump = Math.max(jump, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)))
    }
    expect(jump).toBeLessThan(0.1)
  })

  it('makes three different sounds, timed the same at any sample rate', () => {
    const [chirp, done, error] = CUES.map((cue) => synthesize(cue, RATE))
    expect(new Set([chirp?.length, done?.length, error?.length]).size).toBe(3)
    const slow = synthesize('error', 44_100)
    expect(slow.length / 44_100).toBeCloseTo((error?.length ?? 0) / RATE, 2)
  })
})

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    cwd: 'C:\\work\\demo',
    project: 'demo',
    status: 'working',
    startedAt: 0,
    lastEventAt: 0,
    running: [],
    recent: [],
    stats: { tools: 0, edits: 0, linesAdded: 0, linesRemoved: 0 },
    subagents: 0,
    ...overrides
  }
}

function approval(id: string): PendingApproval {
  return {
    id,
    sessionId: 's1',
    project: 'demo',
    tool: 'Bash',
    verb: 'Running',
    detail: 'npm publish',
    createdAt: 0,
    expiresAt: 110_000
  }
}

function snap(overrides: Partial<IslandSnapshot> = {}): IslandSnapshot {
  return {
    sessions: [session()],
    approvals: [],
    paused: false,
    quiet: false,
    hookServer: { state: 'listening', port: 47821 },
    hooks: 'installed',
    sounds: { needsYou: true, finished: true },
    sentAt: 0,
    ...overrides
  }
}

const waiting = (at: number): Session =>
  session({ status: 'waiting', pendingPermission: { tool: 'Bash', target: 'npm publish', at } })

describe('soundFor', () => {
  it('stays quiet on the first snapshot after a start', () => {
    expect(soundFor(null, snap({ approvals: [approval('a1')] }))).toBeNull()
  })

  it('chirps once for each new request, not for the next one in the queue', () => {
    const one = snap({ approvals: [approval('a1'), approval('a2')], sessions: [waiting(5)] })
    expect(soundFor(snap(), one)).toBe('needs-you')
    expect(soundFor(one, one)).toBeNull()
    // Paul answered a1: a2 was already waiting, so it comes up without a sound.
    expect(soundFor(one, snap({ approvals: [approval('a2')], sessions: [waiting(5)] }))).toBeNull()
  })

  it('chirps for a wait that only Claude Code can answer', () => {
    const before = snap()
    const after = snap({ sessions: [waiting(9)] })
    expect(soundFor(before, after)).toBe('needs-you')
    expect(soundFor(after, snap({ sessions: [waiting(9)] }))).toBeNull()
  })

  it('plays the end of a turn, and an error over a finish', () => {
    expect(soundFor(snap(), snap({ sessions: [session({ finishedAt: 7 })] }))).toBe('finished')
    const both = snap({
      sessions: [session({ id: 'a', finishedAt: 7 }), session({ id: 'b', failedAt: 7 })]
    })
    expect(soundFor(snap(), both)).toBe('error')
    expect(soundFor(both, both)).toBeNull()
  })

  it('puts a request ahead of a finish', () => {
    const next = snap({ approvals: [approval('a1')], sessions: [session({ finishedAt: 7 })] })
    expect(soundFor(snap(), next)).toBe('needs-you')
  })

  it('follows the switches in Settings, and is silent while paused', () => {
    const request = { approvals: [approval('a1')] }
    const finish = { sessions: [session({ finishedAt: 7 })] }
    const quiet = { needsYou: false, finished: false }
    expect(soundFor(snap(), snap({ ...request, sounds: quiet }))).toBeNull()
    expect(soundFor(snap(), snap({ ...finish, sounds: quiet }))).toBeNull()
    expect(soundFor(snap(), snap({ ...request, paused: true }))).toBeNull()
    // Needs-you off doesn't hide a finish that arrives with it.
    const onlyFinished = { needsYou: false, finished: true }
    expect(soundFor(snap(), snap({ ...request, ...finish, sounds: onlyFinished }))).toBe('finished')
  })

  it('is silent behind a full-screen game, and chirps for what waited once it is gone', () => {
    const game = snap({ quiet: true })
    const request = { approvals: [approval('a1')] }
    expect(soundFor(snap(), snap({ ...request, quiet: true }))).toBeNull()
    expect(soundFor(game, snap({ ...request, quiet: true }))).toBeNull()
    expect(soundFor(game, snap({ sessions: [session({ finishedAt: 7 })], quiet: true }))).toBeNull()
    // Back from the game: one chirp for the request that arrived meanwhile.
    const back = snap(request)
    expect(soundFor(snap({ ...request, quiet: true }), back)).toBe('needs-you')
    expect(soundFor(back, back)).toBeNull()
    expect(soundFor(game, snap({ sessions: [waiting(5)] }))).toBe('needs-you')
    // Nothing waiting, or the switch is off: back without a sound. A finish isn't replayed.
    expect(soundFor(game, snap({ sessions: [session({ finishedAt: 7 })] }))).toBeNull()
    const off = { needsYou: false, finished: true }
    expect(soundFor(game, snap({ ...request, sounds: off }))).toBeNull()
  })
})
