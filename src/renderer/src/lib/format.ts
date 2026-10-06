import type { Activity, RiskExplanation, Session, SessionStatus } from '@shared/types'

export type Mood = 'idle' | 'working' | 'alert' | 'happy' | 'sleepy' | 'worried'

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  thinking: 'Thinking',
  working: 'Working',
  waiting: 'Needs you',
  done: 'Done',
  error: 'Error'
}

export function statusLabel(status: SessionStatus): string {
  return STATUS_LABEL[status]
}

export function activityLabel(activity: Pick<Activity, 'verb' | 'target'>): string {
  return activity.target ? `${activity.verb} ${activity.target}` : activity.verb
}

export function diffLabel(activity: Activity): string | null {
  return activity.diff ? `+${activity.diff.added} −${activity.diff.removed}` : null
}

/** The one line that says what a session is doing right now. */
export function headline(session: Session): string {
  const pending = session.pendingPermission
  if (session.status === 'waiting' && pending) {
    return `Needs permission · ${pending.target || pending.tool}`
  }
  const running = session.running[session.running.length - 1]
  if (running) return activityLabel(running)
  if (session.status === 'error') return session.errorMessage ?? 'Stopped with an error'
  if (session.status === 'done') return session.lastMessage ?? 'Finished'
  return session.prompt ? `Thinking about “${session.prompt}”` : 'Thinking…'
}

export function statsLabel(session: Session): string {
  const { tools, edits, linesAdded, linesRemoved } = session.stats
  const parts = [`${tools} ${tools === 1 ? 'step' : 'steps'}`]
  if (edits > 0) {
    parts.push(`${edits} ${edits === 1 ? 'edit' : 'edits'} +${linesAdded} −${linesRemoved}`)
  }
  return parts.join(' · ')
}

export function moodFor(status: SessionStatus | undefined): Mood {
  switch (status) {
    case 'working':
      return 'working'
    case 'waiting':
      return 'alert'
    case 'done':
      return 'happy'
    case 'error':
      return 'worried'
    case 'thinking':
      return 'idle'
    default:
      return 'sleepy'
  }
}

const WANTS_TO: Record<string, string> = {
  Running: 'run',
  Editing: 'edit',
  Writing: 'write',
  Reading: 'read',
  Fetching: 'fetch',
  Searching: 'search',
  Finding: 'search',
  'Searching the web': 'search the web',
  Delegating: 'start a subagent',
  Planning: 'update its plan'
}

/** "Running" becomes "run", for "demo wants to run ...". */
export function wantsTo(verb: string, tool: string): string {
  return WANTS_TO[verb] ?? `use ${tool}`
}

/** Which model explained a risk, and why the local one stepped in for Gemini. */
export function riskModelLabel(explanation: RiskExplanation): string {
  const { route, fellBackFrom } = explanation
  return fellBackFrom ? `${route.model} (Gemini: ${fellBackFrom.reason})` : route.model
}

/** Time left before Claude Code asks for itself, as m:ss. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
