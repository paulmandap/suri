// Data shapes shared by the main process and the island renderer.
// Plain data only (no Node or DOM types), so both sides can import it.

import type { AiSettings, Route } from './ai-config'
import type { RecapOutcome } from './history'

/** What kind of work an activity is; drives the verb and the icon. */
export type ActivityKind =
  'read' | 'edit' | 'write' | 'shell' | 'search' | 'web' | 'agent' | 'plan' | 'other'

/** `stopped` = the tool never reported back (denied, interrupted, or the turn ended). */
export type ActivityStatus = 'running' | 'ok' | 'failed' | 'stopped'

export interface DiffStats {
  added: number
  removed: number
}

export interface Activity {
  /** `tool_use_id` when Claude Code sends one, otherwise generated. */
  id: string
  /** Raw tool name, e.g. `Bash`, `PowerShell`, `mcp__github__create_issue`. */
  tool: string
  kind: ActivityKind
  /** "Reading", "Editing", "Running"… */
  verb: string
  /** Short display target: a path relative to the project, a command, a pattern. */
  target: string
  status: ActivityStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  diff?: DiffStats
}

export type SessionStatus = 'thinking' | 'working' | 'waiting' | 'done' | 'error'

export interface PendingPermission {
  tool: string
  target: string
  at: number
}

export interface SessionStats {
  tools: number
  edits: number
  linesAdded: number
  linesRemoved: number
}

export interface Session {
  /** Claude Code's `session_id`. */
  id: string
  cwd: string
  /** Folder name of `cwd`. */
  project: string
  status: SessionStatus
  startedAt: number
  lastEventAt: number
  /** Latest user prompt, shortened. */
  prompt?: string
  /** `last_assistant_message` from the latest Stop, shortened. */
  lastMessage?: string
  /** Tools that started and haven't reported back yet, oldest first. */
  running: Activity[]
  /** Finished activities, newest first, at most MAX_RECENT. */
  recent: Activity[]
  /** The current turn's numbers; a new prompt starts them again. */
  stats: SessionStats
  pendingPermission?: PendingPermission
  /** Set on Stop; drives the "finished" card. */
  finishedAt?: number
  /** Set on StopFailure; drives the error card. */
  failedAt?: number
  errorMessage?: string
  /** Subagents currently running. */
  subagents: number
  /** Suri is writing the AI recap of the turn that just finished. */
  recapping?: boolean
  /** That recap, once it's written (ADR-021). */
  recap?: SessionRecap
}

/** The finished card's part of a recap. The rest lives in the history. */
export interface SessionRecap {
  title: string
  summary: string
  outcome: RecapOutcome
}

export interface SessionsState {
  sessions: Record<string, Session>
}

export const MAX_RECENT = 6

export type HookServerStatus =
  | { state: 'starting'; port: number }
  | { state: 'listening'; port: number }
  | { state: 'error'; port: number; message: string }

/** Whether Claude Code's user settings send every session's events to Suri (ADR-013). */
export type HookState = 'installed' | 'not-installed' | 'outdated' | 'unreadable'

/** Rules only ever say medium or high (no rule = no opinion); the AI may also say low. */
export type RiskLevel = 'low' | 'medium' | 'high'

export interface RiskFlag {
  level: RiskLevel
  /** Stable rule id, e.g. `force-push`. */
  rule: string
  /** One plain-English sentence for the card. */
  reason: string
}

/** The AI risk explainer's answer for one approval (plan decision 7, ADR-016). */
export interface RiskExplanation {
  /** The higher of the rule and the model, so the AI can never lower a rule's level. */
  level: RiskLevel
  /** What the model alone said, before the rule floor. */
  modelLevel: RiskLevel
  /** One plain-English sentence: what this will do. */
  summary: string
  /** A few short reasons for the level. */
  reasons: string[]
  /** Whether the change can be undone. */
  reversible: boolean
  /** The model that answered. */
  route: Route
  /** Set when Gemini failed first and the local model answered instead. */
  fellBackFrom?: { route: Route; reason: string }
}

/** `ask` = step aside and let Claude Code show its own prompt. */
export type ApprovalDecision = 'allow' | 'deny' | 'ask'

/** A PermissionRequest Suri is holding until Paul answers (or it times out). */
export interface PendingApproval {
  id: string
  sessionId: string
  project: string
  tool: string
  verb: string
  /** The full command or path, so Paul sees exactly what will run. */
  detail: string
  risk?: RiskFlag
  /** The AI risk check is still running. */
  checkingRisk?: boolean
  /** Filled in when the AI risk check answers. Missing if it failed: the rule still shows. */
  explanation?: RiskExplanation
  /** Why the AI risk check gave no explanation, e.g. Ollama isn't running. */
  riskNote?: string
  createdAt: number
  /** When Suri gives up and lets Claude Code ask instead. */
  expiresAt: number
  /** Sent by `npm run replay`: its answer stays out of History, like the rest of a replay. */
  replayed?: true
}

/** Everything the island needs, pushed from main after every change. */
export interface IslandSnapshot {
  /** Most relevant first (see sortSessions). */
  sessions: Session[]
  /** Oldest first. */
  approvals: PendingApproval[]
  paused: boolean
  hookServer: HookServerStatus
  /** Suri's hooks in ~/.claude/settings.json. A project can still have its own (sandbox/). */
  hooks: HookState
  /** Which sounds the island may play (sounds.ts). */
  sounds: { needsYou: boolean; finished: boolean }
  sentAt: number
}

export interface SuriSettings {
  port: number
  /** Bearer token Claude Code must send with every hook (64 hex characters). */
  token: string
  paused: boolean
  /** Leave the overlay out of screen capture and sharing (ADR-005). */
  hideFromCapture: boolean
  /** Force a prompt for high-risk commands even when they're allowed (ADR-007). */
  safetyNet: boolean
  /** A chirp when Claude Code needs Paul: a held request or a wait. */
  soundNeedsYou: boolean
  /** A sound when a session finishes its turn or stops with an error. */
  soundFinished: boolean
  /** Write an AI recap when a turn finishes (ADR-021). */
  recaps: boolean
  /** Which model answers which AI feature (ADR-015). */
  ai: AiSettings
}
