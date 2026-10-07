import type { IslandSnapshot } from './types'

// Suri's sounds, made from a few notes in code (the jsfxr idea from the
// plan): no audio files and nothing to license. Pure math, so the tests can
// check them without speakers. The renderer only plays the samples.

export type SoundCue = 'needs-you' | 'finished' | 'error'

interface Note {
  /** Seconds from the start of the cue. */
  at: number
  /** Hz. With `to`, the pitch glides there over the note. */
  freq: number
  to?: number
  /** Seconds. */
  dur: number
  wave: 'sine' | 'triangle'
  gain: number
}

// Short and soft, like the island: the loudest moment stays below half scale.
const CUES: Record<SoundCue, readonly Note[]> = {
  // The meerkat's lookout call: two quick chirps that rise.
  'needs-you': [
    { at: 0, freq: 1175, to: 1568, dur: 0.075, wave: 'sine', gain: 0.22 },
    { at: 0.11, freq: 1319, to: 1760, dur: 0.09, wave: 'sine', gain: 0.2 }
  ],
  // Done: a warm step up.
  finished: [
    { at: 0, freq: 659, dur: 0.12, wave: 'triangle', gain: 0.2 },
    { at: 0.1, freq: 988, dur: 0.24, wave: 'triangle', gain: 0.18 }
  ],
  // Stopped with an error: one low note that sinks.
  error: [{ at: 0, freq: 392, to: 294, dur: 0.3, wave: 'triangle', gain: 0.2 }]
}

const ATTACK_S = 0.008
const RELEASE_S = 0.012

/** The cue as mono samples in [-1, 1]. Starts and ends at silence, so nothing clicks. */
export function synthesize(cue: SoundCue, sampleRate: number): Float32Array<ArrayBuffer> {
  const notes = CUES[cue]
  const end = Math.max(...notes.map((note) => note.at + note.dur))
  const out = new Float32Array(Math.ceil(end * sampleRate) + 1)
  for (const note of notes) {
    const start = Math.round(note.at * sampleRate)
    const length = Math.round(note.dur * sampleRate)
    let phase = 0
    for (let i = 0; i < length && start + i < out.length; i++) {
      const freq = note.to ? note.freq * (note.to / note.freq) ** (i / length) : note.freq
      phase += (2 * Math.PI * freq) / sampleRate
      const level = note.gain * envelope(i / sampleRate, note.dur)
      out[start + i] = (out[start + i] ?? 0) + level * wave(note.wave, phase)
    }
  }
  return out
}

/** A quick fade in, a gentle decay, and a short fade out. */
function envelope(t: number, dur: number): number {
  const attack = Math.min(1, t / ATTACK_S)
  const release = Math.min(1, Math.max(0, (dur - t) / RELEASE_S))
  return attack * Math.exp((-3 * t) / dur) * release
}

function wave(kind: Note['wave'], phase: number): number {
  if (kind === 'sine') return Math.sin(phase)
  // A triangle is softer than a square and warmer than a sine.
  const x = (phase / (2 * Math.PI)) % 1
  return 4 * Math.abs(x - 0.5) - 1
}

/**
 * The cue a new snapshot calls for, or null. Only something new makes a
 * sound: a request that just arrived, a session that just finished or
 * failed. The first snapshot after a start stays quiet, and so does a
 * paused Suri, or one staying out of a full-screen game (ADR-029). Back
 * from the game, whatever still needs Paul gets its chirp then.
 */
export function soundFor(prev: IslandSnapshot | null, next: IslandSnapshot): SoundCue | null {
  if (!prev || next.paused || next.quiet) return null
  if (prev.quiet) return next.sounds.needsYou && needsPaul(next) ? 'needs-you' : null
  const before = new Map(prev.sessions.map((s) => [s.id, s]))
  const seen = new Set(prev.approvals.map((a) => a.id))

  // A held request also makes its session wait: that's still one sound.
  const newRequest = next.approvals.some((a) => !seen.has(a.id))
  const newWait = next.sessions.some(
    (s) =>
      s.status === 'waiting' &&
      s.pendingPermission !== undefined &&
      s.pendingPermission.at !== before.get(s.id)?.pendingPermission?.at
  )
  if ((newRequest || newWait) && next.sounds.needsYou) return 'needs-you'
  if (!next.sounds.finished) return null

  const changed = (key: 'failedAt' | 'finishedAt'): boolean =>
    next.sessions.some((s) => s[key] !== undefined && s[key] !== before.get(s.id)?.[key])
  if (changed('failedAt')) return 'error'
  if (changed('finishedAt')) return 'finished'
  return null
}

/** A request held for Allow or Deny, or a session waiting on Claude Code's own prompt. */
function needsPaul(snapshot: IslandSnapshot): boolean {
  return (
    snapshot.approvals.length > 0 ||
    snapshot.sessions.some((s) => s.status === 'waiting' && s.pendingPermission !== undefined)
  )
}
