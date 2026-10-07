import { renameSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describeTool, diffStatsFromResponse } from '@shared/activity'
import type { Digest } from '@shared/digest'
import {
  buildTurnFacts,
  dayKey,
  type DaySummary,
  type DecisionOutcome,
  type DecisionView,
  type Recap,
  type RecapState,
  type StepRecord,
  type TurnFacts,
  type TurnStatus,
  type TurnView
} from '@shared/history'
import { digestSchema, parseColumn, recapSchema, turnFactsSchema } from '@shared/history-schemas'
import { isReplay, type HookEvent } from '@shared/hook-events'
import { redactSecrets } from '@shared/redact'
import { projectName } from '@shared/sessions'
import type { ActivityKind, ActivityStatus, PendingApproval, RiskLevel } from '@shared/types'
import { isDamaged, openDatabase, transaction } from './db'

// Suri's history (plan, Phase 6; ADR-020): turns, their steps, the requests
// Suri held, recaps and digests, in %APPDATA%\Suri\history.db. Recording runs
// on every hook event, so it never throws: a broken history must not cost
// Claude Code an answer.

export const HISTORY_FILE = 'history.db'
/** Steps are the bulky part; a turn keeps its counted facts after they go. */
export const STEP_DAYS = 30
export const KEEP_DAYS = 365
/** A turn with no Stop for this long was cut off (Claude Code closed, Suri quit). */
export const STALE_TURN_MS = 6 * 60 * 60_000

const DAY_MS = 24 * 60 * 60_000
const PROMPT_MAX = 2000
const DETAIL_MAX = 1000
const MESSAGE_MAX = 4000
const ERROR_MAX = 300

/** What a recap is written from (ai/recap.ts). */
export interface RecapSource {
  project: string
  prompt?: string
  facts: TurnFacts
  /** Commands and files Paul denied on the island. */
  denied: string[]
  lastMessage?: string
}

export type RecapUpdate =
  { state: 'pending' } | { state: 'done'; recap: Recap } | { state: 'failed'; note: string }

export interface History {
  /** Records one hook event. Returns its turn's id, or null. Never throws. */
  record(event: HookEvent): number | null
  /** How a held request ended. Never throws. */
  recordDecision(approval: PendingApproval, outcome: DecisionOutcome): void
  recapSource(turnId: number): RecapSource | null
  setRecap(turnId: number, update: RecapUpdate): void
  /** Turns whose recap was still waiting when Suri last stopped. */
  pendingRecaps(since: number): number[]
  /** Days with turns, newest first. */
  days(limit?: number): DaySummary[]
  /** A day's turns, newest first. */
  turns(day: string): TurnView[]
  decisions(day: string): DecisionView[]
  digest(day: string): Digest | null
  saveDigest(digest: Digest): void
  /** Drops old rows and closes turns that never ended. */
  prune(): void
  /**
   * Deletes everything, and rewrites the file so the old rows don't linger in
   * its free space. Returns how many turns there were. Throws if it fails.
   */
  clear(): number
  onChange(listener: () => void): () => void
  close(): void
}

export interface HistoryOptions {
  clock?: () => number
  /** Exact values that must never be stored: Suri's hook token, the Gemini key. */
  secrets?: () => readonly string[]
  log?: (line: string) => void
}

export function historyFile(dir: string): string {
  return join(dir, HISTORY_FILE)
}

export type OpenResult = { ok: true; history: History } | { ok: false; message: string }

/**
 * Opens the history in `dir`. A file that isn't a database (or is damaged) is
 * moved aside and a new one started, like settings.json; anything else
 * (a newer Suri's file, a locked file) leaves Suri running without history.
 */
export function openHistory(dir: string, opts: HistoryOptions = {}): OpenResult {
  const file = historyFile(dir)
  try {
    return { ok: true, history: createHistory(openDatabase(file), opts) }
  } catch (err) {
    if (!isDamaged(err)) return { ok: false, message: messageOf(err) }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          renameSync(file + suffix, `${file}${suffix}.bad-${stamp}`)
        } catch (moveErr) {
          if ((moveErr as NodeJS.ErrnoException).code !== 'ENOENT') throw moveErr
        }
      }
      opts.log?.(`history: ${messageOf(err)}; moved aside and started a new one`)
      return { ok: true, history: createHistory(openDatabase(file), opts) }
    } catch (again) {
      return { ok: false, message: messageOf(again) }
    }
  }
}

interface TurnRow {
  id: number
  session_id: string
  prompt_id: string | null
  cwd: string
  project: string
  day: string
  prompt: string | null
  status: string
  started_at: number
  ended_at: number | null
  last_message: string | null
  error: string | null
  facts: string | null
  recap: string | null
  recap_state: string | null
  recap_note: string | null
}

interface DecisionRow {
  turn_id: number | null
  tool: string
  detail: string
  level: string | null
  outcome: string
  asked_at: number
  answered_at: number
}

type ToolEvent = Extract<
  HookEvent,
  { hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' }
>

export function createHistory(db: DatabaseSync, opts: HistoryOptions = {}): History {
  const clock = opts.clock ?? Date.now
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const q = {
    turnByPrompt: db.prepare('SELECT id FROM turns WHERE session_id = ? AND prompt_id = ?'),
    openTurn: db.prepare(
      `SELECT id FROM turns WHERE session_id = ? AND status = 'running'
       ORDER BY started_at DESC, id DESC LIMIT 1`
    ),
    openTurns: db.prepare(
      "SELECT id FROM turns WHERE session_id = ? AND status = 'running' AND id != ?"
    ),
    insertTurn: db.prepare(
      `INSERT INTO turns (session_id, prompt_id, cwd, project, day, prompt, status, started_at)
       VALUES ($session, $promptId, $cwd, $project, $day, $prompt, 'running', $at)`
    ),
    setPrompt: db.prepare('UPDATE turns SET prompt = ? WHERE id = ?'),
    turn: db.prepare('SELECT * FROM turns WHERE id = ?'),
    endTurn: db.prepare(
      `UPDATE turns SET status = $status, ended_at = $at, facts = $facts,
         last_message = coalesce($message, last_message), error = coalesce($error, error)
       WHERE id = $id`
    ),
    stopSteps: db.prepare(
      "UPDATE steps SET status = 'stopped', ended_at = ? WHERE turn_id = ? AND status = 'running'"
    ),
    steps: db.prepare(
      'SELECT tool, kind, detail, status, added, removed FROM steps WHERE turn_id = ? ORDER BY id'
    ),
    insertStep: db.prepare(
      `INSERT INTO steps (turn_id, tool_use_id, tool, kind, target, detail, status, started_at,
         ended_at, added, removed, error)
       VALUES ($turn, $toolUseId, $tool, $kind, $target, $detail, $status, $at, $endedAt,
         $added, $removed, $error)`
    ),
    stepByToolUse: db.prepare(
      'SELECT id FROM steps WHERE tool_use_id = ? ORDER BY id DESC LIMIT 1'
    ),
    runningStep: db.prepare(
      "SELECT id FROM steps WHERE turn_id = ? AND tool = ? AND status = 'running' ORDER BY id LIMIT 1"
    ),
    settleStep: db.prepare(
      `UPDATE steps SET status = $status, ended_at = $at, added = $added, removed = $removed,
         error = $error WHERE id = $id`
    ),
    insertDecision: db.prepare(
      `INSERT INTO decisions (session_id, turn_id, day, tool, detail, level, outcome, asked_at,
         answered_at)
       VALUES ($session, $turn, $day, $tool, $detail, $level, $outcome, $askedAt, $answeredAt)`
    ),
    deniedIn: db.prepare("SELECT detail FROM decisions WHERE turn_id = ? AND outcome = 'deny'"),
    setRecap: db.prepare(
      'UPDATE turns SET recap_state = $state, recap = $recap, recap_note = $note WHERE id = $id'
    ),
    pending: db.prepare(
      "SELECT id FROM turns WHERE recap_state = 'pending' AND started_at >= ? ORDER BY id"
    ),
    days: db.prepare(
      `SELECT day, COUNT(*) AS turns, COUNT(DISTINCT project) AS projects FROM turns
       GROUP BY day ORDER BY day DESC LIMIT ?`
    ),
    turnsOn: db.prepare('SELECT * FROM turns WHERE day = ? ORDER BY started_at DESC, id DESC'),
    decisionsOn: db.prepare('SELECT * FROM decisions WHERE day = ? ORDER BY asked_at, id'),
    digest: db.prepare('SELECT digest FROM digests WHERE day = ?'),
    saveDigest: db.prepare(
      `INSERT INTO digests (day, digest, created_at) VALUES (?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET digest = excluded.digest, created_at = excluded.created_at`
    ),
    staleTurns: db.prepare("SELECT id FROM turns WHERE status = 'running' AND started_at < ?"),
    pruneSteps: db.prepare('DELETE FROM steps WHERE started_at < ?'),
    pruneTurns: db.prepare('DELETE FROM turns WHERE started_at < ?'),
    pruneDecisions: db.prepare('DELETE FROM decisions WHERE asked_at < ?'),
    pruneDigests: db.prepare('DELETE FROM digests WHERE created_at < ?')
  }

  /** Redacted first, then cut, so a cut never leaves half a secret unrecognised. */
  const clean = (value: string | undefined | null, max: number): string | null => {
    if (!value) return null
    const rough = value.length > max * 4 ? value.slice(0, max * 4) : value
    const redacted = redactSecrets(rough, opts.secrets?.() ?? []).text
    return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted
  }

  const startTurn = (event: HookEvent, prompt: string | null, now: number): number => {
    const result = q.insertTurn.run({
      session: event.session_id,
      promptId: event.prompt_id ?? null,
      cwd: event.cwd,
      project: projectName(event.cwd),
      day: dayKey(now),
      prompt: clean(prompt, PROMPT_MAX),
      at: now
    })
    return Number(result.lastInsertRowid)
  }

  /** The turn an event belongs to; a turn seen mid-way (Suri started late) is opened. */
  const turnOf = (event: HookEvent, now: number): number => {
    const found = (
      event.prompt_id
        ? q.turnByPrompt.get(event.session_id, event.prompt_id)
        : q.openTurn.get(event.session_id)
    ) as { id: number } | undefined
    return found ? found.id : startTurn(event, null, now)
  }

  const factsOf = (turnId: number, cwd: string, durationMs: number): TurnFacts => {
    const rows = q.steps.all(turnId) as unknown as StepRow[]
    return buildTurnFacts(rows.map(stepRecord), cwd, durationMs)
  }

  const endTurn = (
    turnId: number,
    status: TurnStatus,
    now: number,
    extra: { message?: string | null; error?: string | null } = {}
  ): void => {
    const row = q.turn.get(turnId) as TurnRow | undefined
    if (!row) return
    q.stopSteps.run(now, turnId)
    q.endTurn.run({
      id: turnId,
      status,
      at: now,
      facts: JSON.stringify(factsOf(turnId, row.cwd, now - row.started_at)),
      message: extra.message ?? null,
      error: extra.error ?? null
    })
  }

  const recordTool = (event: ToolEvent, turnId: number, now: number): void => {
    const desc = describeTool(event.tool_name, event.tool_input, event.cwd)
    if (event.hook_event_name === 'PreToolUse') {
      q.insertStep.run({
        turn: turnId,
        toolUseId: event.tool_use_id ?? null,
        tool: event.tool_name,
        kind: desc.kind,
        target: desc.target,
        detail: clean(detailOf(event.tool_input), DETAIL_MAX) ?? '',
        status: 'running',
        at: now,
        endedAt: null,
        added: null,
        removed: null,
        error: null
      })
      return
    }
    const ok = event.hook_event_name === 'PostToolUse'
    const diff = ok ? diffStatsFromResponse(event.tool_name, event.tool_response) : undefined
    const error = ok ? null : clean(errorText(event.error), ERROR_MAX)
    const found = (
      event.tool_use_id
        ? q.stepByToolUse.get(event.tool_use_id)
        : q.runningStep.get(turnId, event.tool_name)
    ) as { id: number } | undefined
    if (found) {
      q.settleStep.run({
        id: found.id,
        status: ok ? 'ok' : 'failed',
        at: now,
        added: diff?.added ?? null,
        removed: diff?.removed ?? null,
        error
      })
      return
    }
    // PreToolUse went missing (Suri started mid-call): still record what finished.
    q.insertStep.run({
      turn: turnId,
      toolUseId: event.tool_use_id ?? null,
      tool: event.tool_name,
      kind: desc.kind,
      target: desc.target,
      detail: clean(detailOf(event.tool_input), DETAIL_MAX) ?? '',
      status: ok ? 'ok' : 'failed',
      at: now,
      endedAt: now,
      added: diff?.added ?? null,
      removed: diff?.removed ?? null,
      error
    })
  }

  /** Returns the turn id, and whether the History window should hear about it. */
  const apply = (event: HookEvent, now: number): { turn: number | null; changed: boolean } => {
    switch (event.hook_event_name) {
      case 'UserPromptSubmit': {
        const existing = event.prompt_id
          ? (q.turnByPrompt.get(event.session_id, event.prompt_id) as { id: number } | undefined)
          : undefined
        if (existing) {
          q.setPrompt.run(clean(event.prompt, PROMPT_MAX), existing.id)
          return { turn: existing.id, changed: true }
        }
        // A new prompt ends whatever was still open in this session (Esc, then a new request).
        for (const open of q.openTurns.all(event.session_id, -1) as { id: number }[]) {
          endTurn(open.id, 'interrupted', now)
        }
        return { turn: startTurn(event, event.prompt, now), changed: true }
      }
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const turn = turnOf(event, now)
        recordTool(event, turn, now)
        return { turn, changed: false }
      }
      case 'PermissionRequest':
        return { turn: turnOf(event, now), changed: false }
      case 'Stop': {
        const turn = turnOf(event, now)
        endTurn(turn, 'done', now, { message: clean(event.last_assistant_message, MESSAGE_MAX) })
        return { turn, changed: true }
      }
      case 'StopFailure': {
        const turn = turnOf(event, now)
        endTurn(turn, 'error', now, { error: clean(errorText(event.error), ERROR_MAX) })
        return { turn, changed: true }
      }
      case 'SessionEnd': {
        const open = q.openTurns.all(event.session_id, -1) as { id: number }[]
        for (const { id } of open) endTurn(id, 'interrupted', now)
        return { turn: null, changed: open.length > 0 }
      }
      case 'Notification':
      case 'SubagentStart':
      case 'SubagentStop':
        return { turn: null, changed: false }
    }
  }

  const safely = <T>(what: string, fallback: T, fn: () => T): T => {
    try {
      return fn()
    } catch (err) {
      opts.log?.(`history: ${what} failed: ${messageOf(err)}`)
      return fallback
    }
  }

  const turnView = (row: TurnRow, decisions: DecisionView[]): TurnView => ({
    id: row.id,
    sessionId: row.session_id,
    project: row.project,
    day: row.day,
    ...(row.prompt ? { prompt: row.prompt } : {}),
    status: turnStatus(row.status),
    startedAt: row.started_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(row.last_message ? { lastMessage: row.last_message } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...optional('facts', parseColumn(row.facts, turnFactsSchema)),
    ...optional('recap', parseColumn(row.recap, recapSchema)),
    ...optional('recapState', recapState(row.recap_state)),
    ...(row.recap_note ? { recapNote: row.recap_note } : {}),
    decisions
  })

  return {
    record: (event) =>
      safely('recording an event', null, () => {
        // `npm run replay` marks its payloads, so demos stay out of Paul's history.
        if (isReplay(event)) return null
        const { turn, changed } = transaction(db, () => apply(event, clock()))
        if (changed) emit()
        return turn
      }),

    recordDecision: (approval, outcome) =>
      safely('recording a decision', undefined, () => {
        const now = clock()
        const open = q.openTurn.get(approval.sessionId) as { id: number } | undefined
        q.insertDecision.run({
          session: approval.sessionId,
          turn: open?.id ?? null,
          day: dayKey(approval.createdAt),
          tool: approval.tool,
          detail: clean(approval.detail, DETAIL_MAX) ?? '',
          level: approval.explanation?.level ?? approval.risk?.level ?? null,
          outcome,
          askedAt: approval.createdAt,
          answeredAt: now
        })
        emit()
      }),

    recapSource(turnId) {
      const row = q.turn.get(turnId) as TurnRow | undefined
      if (!row) return null
      const facts =
        parseColumn(row.facts, turnFactsSchema) ??
        factsOf(turnId, row.cwd, (row.ended_at ?? clock()) - row.started_at)
      const denied = (q.deniedIn.all(turnId) as { detail: string }[]).map((d) => d.detail)
      if (!row.prompt && !row.last_message && facts.steps === 0) return null
      return {
        project: row.project,
        ...(row.prompt ? { prompt: row.prompt } : {}),
        facts,
        denied,
        ...(row.last_message ? { lastMessage: row.last_message } : {})
      }
    },

    setRecap(turnId, update) {
      safely('saving a recap', undefined, () => {
        q.setRecap.run({
          id: turnId,
          state: update.state,
          recap: update.state === 'done' ? JSON.stringify(update.recap) : null,
          note: update.state === 'failed' ? update.note : null
        })
        emit()
      })
    },

    pendingRecaps: (since) => (q.pending.all(since) as { id: number }[]).map((row) => row.id),

    days: (limit = 90) =>
      (q.days.all(limit) as unknown as DaySummary[]).map((row) => ({
        day: row.day,
        turns: Number(row.turns),
        projects: Number(row.projects)
      })),

    turns(day) {
      const byTurn = new Map<number, DecisionView[]>()
      for (const row of q.decisionsOn.all(day) as unknown as DecisionRow[]) {
        if (row.turn_id === null) continue
        const list = byTurn.get(row.turn_id) ?? []
        list.push(decisionView(row))
        byTurn.set(row.turn_id, list)
      }
      return (q.turnsOn.all(day) as unknown as TurnRow[]).map((row) =>
        turnView(row, byTurn.get(row.id) ?? [])
      )
    },

    decisions: (day) => (q.decisionsOn.all(day) as unknown as DecisionRow[]).map(decisionView),

    digest(day) {
      const row = q.digest.get(day) as { digest: string } | undefined
      return row ? (parseColumn(row.digest, digestSchema) ?? null) : null
    },

    saveDigest(digest) {
      q.saveDigest.run(digest.day, JSON.stringify(digest), digest.createdAt)
      emit()
    },

    prune() {
      safely('pruning', undefined, () => {
        const now = clock()
        transaction(db, () => {
          for (const { id } of q.staleTurns.all(now - STALE_TURN_MS) as { id: number }[]) {
            const row = q.turn.get(id) as TurnRow | undefined
            // When it was cut off is unknown; its start is the honest guess.
            if (row) endTurn(id, 'interrupted', row.started_at)
          }
          q.pruneSteps.run(now - STEP_DAYS * DAY_MS)
          const keep = now - KEEP_DAYS * DAY_MS
          q.pruneTurns.run(keep)
          q.pruneDecisions.run(keep)
          q.pruneDigests.run(keep)
        })
      })
    },

    clear() {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }
      transaction(db, () => {
        db.exec('DELETE FROM decisions; DELETE FROM digests; DELETE FROM steps; DELETE FROM turns;')
      })
      // VACUUM rebuilds the file without the deleted pages; the checkpoint
      // empties the write-ahead log, which held copies of them too.
      db.exec('VACUUM')
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      emit()
      return Number(n)
    },

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    close: () => db.close()
  }
}

interface StepRow {
  tool: string
  kind: string
  detail: string
  status: string
  added: number | null
  removed: number | null
}

const KINDS = new Set<ActivityKind>([
  'read',
  'edit',
  'write',
  'shell',
  'search',
  'web',
  'agent',
  'plan',
  'other'
])
const STEP_STATUSES = new Set<ActivityStatus>(['running', 'ok', 'failed', 'stopped'])

function stepRecord(row: StepRow): StepRecord {
  return {
    tool: row.tool,
    kind: KINDS.has(row.kind as ActivityKind) ? (row.kind as ActivityKind) : 'other',
    detail: row.detail,
    status: STEP_STATUSES.has(row.status as ActivityStatus)
      ? (row.status as ActivityStatus)
      : 'stopped',
    ...(row.added !== null ? { added: row.added } : {}),
    ...(row.removed !== null ? { removed: row.removed } : {})
  }
}

const TURN_STATUSES = new Set<TurnStatus>(['running', 'done', 'error', 'interrupted'])
function turnStatus(value: string): TurnStatus {
  return TURN_STATUSES.has(value as TurnStatus) ? (value as TurnStatus) : 'interrupted'
}

const RECAP_STATES = new Set<RecapState>(['pending', 'done', 'failed'])
function recapState(value: string | null): RecapState | undefined {
  return RECAP_STATES.has(value as RecapState) ? (value as RecapState) : undefined
}

const OUTCOMES = new Set<DecisionOutcome>(['allow', 'deny', 'ask', 'timeout', 'gone'])
const LEVELS = new Set<RiskLevel>(['low', 'medium', 'high'])
function decisionView(row: DecisionRow): DecisionView {
  return {
    tool: row.tool,
    detail: row.detail,
    ...(LEVELS.has(row.level as RiskLevel) ? { level: row.level as RiskLevel } : {}),
    outcome: OUTCOMES.has(row.outcome as DecisionOutcome)
      ? (row.outcome as DecisionOutcome)
      : 'gone',
    askedAt: row.asked_at,
    answeredAt: row.answered_at
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

/** The command or path, as the approval card shows it. */
function detailOf(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query']) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return JSON.stringify(input)
}

function errorText(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string') return message
  }
  return error === undefined ? undefined : JSON.stringify(error)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
