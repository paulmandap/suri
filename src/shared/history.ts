import { displayPath, shorten } from './activity'
import type { ActivityKind, ActivityStatus, RiskLevel } from './types'

// Suri's history (plan, Phase 6; ADR-020, ADR-021). Plain data and pure
// decisions, shared by main and the History window, so no Zod here.

/** `interrupted`: a new prompt or the session's end came before Stop. */
export type TurnStatus = 'running' | 'done' | 'error' | 'interrupted'

/** How a turn ended, in the recap's words. */
export type RecapOutcome = 'done' | 'partial' | 'needs-input' | 'failed'

export const RECAP_OUTCOMES: readonly RecapOutcome[] = ['done', 'partial', 'needs-input', 'failed']

/** One tool call, as the history keeps it. */
export interface StepRecord {
  tool: string
  kind: ActivityKind
  /** The full command or path (redacted, cut to a sane length). */
  detail: string
  status: ActivityStatus
  added?: number
  removed?: number
}

export interface FileChange {
  /** Relative to the project when it's inside it. */
  path: string
  added: number
  removed: number
}

export interface CommandRun {
  command: string
  /** A command that never reported back (denied, interrupted) counts as stopped. */
  status: 'ok' | 'failed' | 'stopped'
}

/**
 * What happened in a turn, counted from its steps. Facts come from the
 * events and words from the model (ADR-021), so a recap can't invent a file.
 */
export interface TurnFacts {
  durationMs: number
  steps: number
  filesChanged: FileChange[]
  /** Changed files left out of the list. */
  moreFiles: number
  linesAdded: number
  linesRemoved: number
  /** The latest commands, oldest first. */
  commands: CommandRun[]
  /** Earlier commands left out of the list. */
  moreCommands: number
  reads: number
  searches: number
  web: number
  agents: number
  /** Steps that reported a failure. */
  failed: number
}

/** The model's part of a recap, plus who wrote it. */
export interface Recap {
  title: string
  summary: string
  outcome: RecapOutcome
  followUps: string[]
  /** The model that answered. */
  model: string
  /** Set when Gemini failed first and the local model answered instead. */
  fellBackFrom?: string
}

export type RecapState = 'pending' | 'done' | 'failed'

/** How a request Suri held ended. `gone` = Claude Code stopped waiting, or Suri paused or quit. */
export type DecisionOutcome = 'allow' | 'deny' | 'ask' | 'timeout' | 'gone'

export interface DecisionView {
  tool: string
  detail: string
  /** The level the card showed. */
  level?: RiskLevel
  outcome: DecisionOutcome
  askedAt: number
  answeredAt: number
}

/** One turn as the History window shows it. */
export interface TurnView {
  id: number
  sessionId: string
  project: string
  day: string
  prompt?: string
  status: TurnStatus
  startedAt: number
  endedAt?: number
  lastMessage?: string
  error?: string
  facts?: TurnFacts
  recap?: Recap
  recapState?: RecapState
  /** Why there's no recap. */
  recapNote?: string
  decisions: DecisionView[]
}

export interface DaySummary {
  /** Local date, YYYY-MM-DD. */
  day: string
  turns: number
  projects: number
}

export const MAX_FILES = 12
export const MAX_COMMANDS = 10
const COMMAND_MAX = 160
const PATH_MAX = 90

/** The local date of a moment, as YYYY-MM-DD. "Today" is Paul's day, not UTC's. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The local day before `day`. */
export function previousDay(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d - 1, 12).getTime())
}

// Written out by hand: Node and Chromium carry different locale data, and the
// tests, main and the History window must agree.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function dateOf(day: string): Date {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

/** "Wednesday 7 October 2026" for a YYYY-MM-DD day. */
export function dayTitle(day: string): string {
  const date = dateOf(day)
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

/** "Today", "Yesterday", or a short date like "Mon 5 Oct" (with the year when it isn't this one). */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today'
  if (day === previousDay(today)) return 'Yesterday'
  const date = dateOf(day)
  const short = `${WEEKDAYS[date.getDay()]?.slice(0, 3)} ${date.getDate()} ${MONTHS[date.getMonth()]?.slice(0, 3)}`
  return day.slice(0, 4) === today.slice(0, 4) ? short : `${short} ${date.getFullYear()}`
}

/** Counts a turn's steps into facts. Pure, so every rule is unit tested. */
export function buildTurnFacts(
  steps: readonly StepRecord[],
  cwd: string,
  durationMs: number
): TurnFacts {
  const files = new Map<string, FileChange>()
  const commands: CommandRun[] = []
  const facts: TurnFacts = {
    durationMs: Math.max(0, durationMs),
    steps: steps.length,
    filesChanged: [],
    moreFiles: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commands: [],
    moreCommands: 0,
    reads: 0,
    searches: 0,
    web: 0,
    agents: 0,
    failed: 0
  }
  for (const step of steps) {
    if (step.status === 'failed') facts.failed++
    switch (step.kind) {
      case 'edit':
      case 'write': {
        if (step.status !== 'ok') break
        const path = displayPath(step.detail, cwd, PATH_MAX) || step.tool
        const added = step.added ?? 0
        const removed = step.removed ?? 0
        const seen = files.get(path.toLowerCase())
        if (seen) {
          seen.added += added
          seen.removed += removed
        } else {
          files.set(path.toLowerCase(), { path, added, removed })
        }
        facts.linesAdded += added
        facts.linesRemoved += removed
        break
      }
      case 'shell':
        commands.push({
          command: commandLine(step.detail),
          status: step.status === 'ok' || step.status === 'failed' ? step.status : 'stopped'
        })
        break
      case 'read':
        facts.reads++
        break
      case 'search':
        facts.searches++
        break
      case 'web':
        facts.web++
        break
      case 'agent':
        facts.agents++
        break
    }
  }
  const changed = [...files.values()]
  facts.filesChanged = changed.slice(0, MAX_FILES)
  facts.moreFiles = Math.max(0, changed.length - MAX_FILES)
  // The latest runs say how the turn ended (the last test run, say).
  facts.commands = commands.slice(-MAX_COMMANDS)
  facts.moreCommands = Math.max(0, commands.length - MAX_COMMANDS)
  return facts
}

/** A command on one line: its first line, with a mark when more followed. */
export function commandLine(command: string): string {
  const lines = command.trim().split(/\r?\n/)
  const first = shorten(lines[0] ?? '', COMMAND_MAX)
  return lines.length > 1 && !first.endsWith('…') ? `${first} …` : first
}

/** What a turn is called when it has no recap: its request, else its answer. */
export function turnTitle(turn: Pick<TurnView, 'recap' | 'prompt' | 'lastMessage'>): string {
  if (turn.recap) return turn.recap.title
  if (turn.prompt) return shorten(turn.prompt, 90)
  if (turn.lastMessage) return shorten(turn.lastMessage, 90)
  return 'A turn Suri saw only part of'
}

/** "+12 −3", or "" when nothing changed. */
export function linesLabel(added: number, removed: number): string {
  return added === 0 && removed === 0 ? '' : `+${added} −${removed}`
}

/** A short duration: "45 s", "3 min", "1 h 20 min". */
export function durationLabel(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
