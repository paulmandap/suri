import type { HookEvent } from './hook-events'
import { describeTool, diffStatsFromResponse, shorten } from './activity'
import {
  MAX_RECENT,
  type Activity,
  type ActivityStatus,
  type DiffStats,
  type Session,
  type SessionStatus,
  type SessionsState
} from './types'

/** Notification types that mean Claude Code is waiting for the user. */
const NEEDS_USER = new Set([
  'permission_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog'
])

/** Most relevant first: something waiting on Paul beats everything else. */
const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0,
  working: 1,
  thinking: 2,
  error: 3,
  done: 4
}

/** Sessions without events for this long are dropped (Claude Code may die without SessionEnd). */
export const DEFAULT_MAX_IDLE_MS = 30 * 60_000

export function createSessionsState(): SessionsState {
  return { sessions: {} }
}

export function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/**
 * Applies one hook event. Pure: returns a new state and keeps untouched
 * sessions as the same objects. SessionStart never arrives over HTTP
 * (ADR-003), so the first event with a new session_id opens the session.
 */
export function reduceSessions(state: SessionsState, event: HookEvent, now: number): SessionsState {
  if (event.hook_event_name === 'SessionEnd') {
    if (!(event.session_id in state.sessions)) return state
    const sessions = { ...state.sessions }
    delete sessions[event.session_id]
    return { sessions }
  }
  const existing = state.sessions[event.session_id]
  const cwd = event.cwd || existing?.cwd || ''
  const base: Session = existing
    ? { ...existing, cwd, project: projectName(cwd), lastEventAt: now }
    : openSession(event.session_id, cwd, now)
  return { sessions: { ...state.sessions, [base.id]: applyEvent(base, event, now) } }
}

/** Drops sessions that went quiet. Ones with a tool still running get four times as long. */
export function pruneSessions(
  state: SessionsState,
  now: number,
  maxIdleMs = DEFAULT_MAX_IDLE_MS
): SessionsState {
  const stale = Object.values(state.sessions).filter((s) => {
    const limit = s.running.length > 0 ? maxIdleMs * 4 : maxIdleMs
    return now - s.lastEventAt > limit
  })
  if (stale.length === 0) return state
  const sessions = { ...state.sessions }
  for (const s of stale) delete sessions[s.id]
  return { sessions }
}

export function sortSessions(state: SessionsState): Session[] {
  return Object.values(state.sessions).sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.lastEventAt - a.lastEventAt
  )
}

function openSession(id: string, cwd: string, now: number): Session {
  return {
    id,
    cwd,
    project: projectName(cwd),
    status: 'thinking',
    startedAt: now,
    lastEventAt: now,
    running: [],
    recent: [],
    stats: { tools: 0, edits: 0, linesAdded: 0, linesRemoved: 0 },
    subagents: 0
  }
}

function applyEvent(s: Session, event: HookEvent, now: number): Session {
  switch (event.hook_event_name) {
    case 'UserPromptSubmit':
      return {
        ...settle(s, now),
        status: 'thinking',
        prompt: shorten(event.prompt, 200),
        lastMessage: undefined,
        finishedAt: undefined,
        failedAt: undefined,
        errorMessage: undefined
      }

    case 'PreToolUse': {
      const activity: Activity = {
        id: event.tool_use_id ?? `${event.tool_name}-${now}-${s.stats.tools}`,
        tool: event.tool_name,
        ...describeTool(event.tool_name, event.tool_input, event.cwd),
        status: 'running',
        startedAt: now
      }
      return {
        ...s,
        status: 'working',
        pendingPermission: undefined,
        running: [...s.running.filter((a) => a.id !== activity.id), activity],
        stats: { ...s.stats, tools: s.stats.tools + 1 }
      }
    }

    case 'PostToolUse':
      return finishTool(
        s,
        event,
        now,
        'ok',
        event.duration_ms,
        diffStatsFromResponse(event.tool_name, event.tool_response)
      )

    case 'PostToolUseFailure':
      return finishTool(s, event, now, 'failed')

    case 'PermissionRequest':
      return {
        ...s,
        status: 'waiting',
        pendingPermission: {
          tool: event.tool_name,
          target: describeTool(event.tool_name, event.tool_input, event.cwd).target,
          at: now
        }
      }

    case 'Notification': {
      if (!event.notification_type || !NEEDS_USER.has(event.notification_type)) return s
      const pending = s.pendingPermission ?? {
        tool: 'Claude',
        target: shorten(event.message || 'Claude Code needs you', 80),
        at: now
      }
      return { ...s, status: 'waiting', pendingPermission: pending }
    }

    case 'Stop':
      return {
        ...settle(s, now),
        status: 'done',
        finishedAt: now,
        lastMessage: event.last_assistant_message
          ? shorten(event.last_assistant_message, 300)
          : undefined
      }

    case 'StopFailure':
      return {
        ...settle(s, now),
        status: 'error',
        failedAt: now,
        errorMessage: describeError(event.error)
      }

    case 'SubagentStart':
      return { ...s, subagents: s.subagents + 1 }

    case 'SubagentStop':
      return { ...s, subagents: Math.max(0, s.subagents - 1) }

    case 'SessionEnd':
      return s
  }
}

interface ToolEvent {
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id?: string
  cwd: string
}

function finishTool(
  s: Session,
  event: ToolEvent,
  now: number,
  status: Extract<ActivityStatus, 'ok' | 'failed'>,
  durationMs?: number,
  diff?: DiffStats
): Session {
  const index = findRunning(s.running, event.tool_use_id, event.tool_name)
  const started: Activity = s.running[index] ?? {
    // PreToolUse went missing: still record what finished.
    id: event.tool_use_id ?? `${event.tool_name}-${now}`,
    tool: event.tool_name,
    ...describeTool(event.tool_name, event.tool_input, event.cwd),
    status: 'running',
    startedAt: now
  }
  const finished: Activity = {
    ...started,
    status,
    endedAt: now,
    durationMs: durationMs ?? now - started.startedAt,
    ...(diff ? { diff } : {})
  }
  const running = index >= 0 ? s.running.filter((_, i) => i !== index) : s.running
  const isEdit = finished.kind === 'edit' || finished.kind === 'write'
  const stats =
    status === 'ok' && isEdit && diff
      ? {
          ...s.stats,
          edits: s.stats.edits + 1,
          linesAdded: s.stats.linesAdded + diff.added,
          linesRemoved: s.stats.linesRemoved + diff.removed
        }
      : s.stats
  return {
    ...s,
    status: running.length > 0 ? 'working' : 'thinking',
    pendingPermission: undefined,
    running,
    recent: pushRecent(s.recent, finished),
    stats
  }
}

/** Matches by tool_use_id; without one, the oldest running call of the same tool. */
function findRunning(running: Activity[], id: string | undefined, tool: string): number {
  if (id) {
    const byId = running.findIndex((a) => a.id === id)
    if (byId >= 0) return byId
  }
  return running.findIndex((a) => a.tool === tool)
}

/** Ends the turn: tools that never reported back (denied, interrupted) become `stopped`. */
function settle(s: Session, now: number): Session {
  if (s.running.length === 0 && !s.pendingPermission) return s
  let recent = s.recent
  for (const a of s.running) {
    recent = pushRecent(recent, {
      ...a,
      status: 'stopped',
      endedAt: now,
      durationMs: now - a.startedAt
    })
  }
  return { ...s, running: [], recent, pendingPermission: undefined }
}

function pushRecent(recent: Activity[], activity: Activity): Activity[] {
  return [activity, ...recent.filter((a) => a.id !== activity.id)].slice(0, MAX_RECENT)
}

function describeError(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return shorten(error, 160)
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message.trim()) return shorten(message, 160)
  }
  return 'Claude Code stopped with an error.'
}
