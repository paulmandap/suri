import type { Digest } from './digest'
import type { DaySummary, TurnView } from './history'

// The History window talks to main over its own channels (like Settings,
// ADR-014). Types only besides the channel names: the sandboxed preload imports this.

export const HISTORY_IPC = {
  /** renderer → main (invoke): the days with history. */
  getDays: 'suri:history-get-days',
  /** renderer → main (invoke): one day's turns and digest. */
  getDay: 'suri:history-get-day',
  /** main → renderer: something changed; ask again. */
  changed: 'suri:history-changed',
  /** main → renderer: show this day (the tray's "Today's digest"). */
  showDay: 'suri:history-show-day',
  /** renderer → main (invoke): write (or rewrite) a day's digest. Resolves when it's saved. */
  writeDigest: 'suri:history-write-digest',
  /** renderer → main (invoke): copy a day's digest as Markdown. */
  copyDigest: 'suri:history-copy-digest',
  /** renderer → main (invoke): save a day's digest as a .md file, through a save dialog. */
  saveDigest: 'suri:history-save-digest',
  /** renderer → main (invoke): write a turn's recap again. */
  writeRecap: 'suri:history-write-recap'
} as const

export interface DaysView {
  /** Paul's local date, YYYY-MM-DD. */
  today: string
  /** Newest first. Today is always there, even before any work. */
  days: DaySummary[]
  /** Why there's no history, when the database couldn't be opened. */
  unavailable?: string
}

export interface DigestStatus {
  writing: boolean
  digest: Digest | null
  /** Turns that came in after the digest was written. */
  newTurns: number
}

export interface DayView {
  day: string
  /** Newest first. */
  turns: TurnView[]
  digest: DigestStatus
}

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; message: string }

/** The only API the History window gets (`window.suriHistory`). */
export interface SuriHistoryApi {
  getDays(): Promise<DaysView>
  getDay(day: string): Promise<DayView | null>
  onChanged(callback: () => void): () => void
  onShowDay(callback: (day: string) => void): () => void
  writeDigest(day: string): Promise<boolean>
  copyDigest(day: string): Promise<boolean>
  saveDigest(day: string): Promise<SaveResult>
  writeRecap(turnId: number): Promise<boolean>
}
