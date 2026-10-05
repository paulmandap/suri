// Data shapes shared by the main process and the island renderer.
// Plain data only (no Node or DOM types), so both sides can import it.

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
  stats: SessionStats
  pendingPermission?: PendingPermission
  /** Set on Stop; drives the "finished" card. */
  finishedAt?: number
  /** Set on StopFailure; drives the error card. */
  failedAt?: number
  errorMessage?: string
  /** Subagents currently running. */
  subagents: number
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

export type RiskLevel = 'medium' | 'high'

export interface RiskFlag {
  level: RiskLevel
  /** Stable rule id, e.g. `force-push`. */
  rule: string
  /** One plain-English sentence for the card. */
  reason: string
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
  createdAt: number
  /** When Suri gives up and lets Claude Code ask instead. */
  expiresAt: number
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
}
