import type { Activity, SessionStatus } from '@shared/types'
import { activityLabel, diffLabel } from '../lib/format'

const DOT: Record<SessionStatus, string> = {
  working: 'bg-teal-400',
  thinking: 'bg-sky-300',
  waiting: 'bg-amber-400',
  done: 'bg-emerald-400',
  error: 'bg-red-400'
}

export function StatusDot({ status }: { status: SessionStatus }): React.JSX.Element {
  const live = status === 'working' || status === 'thinking' || status === 'waiting'
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {live && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${DOT[status]}`}
        />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${DOT[status]}`} />
    </span>
  )
}

const MARK: Record<Activity['status'], { sign: string; tone: string }> = {
  ok: { sign: '✓', tone: 'text-emerald-300' },
  failed: { sign: '✕', tone: 'text-red-300' },
  stopped: { sign: '–', tone: 'text-white/40' },
  running: { sign: '…', tone: 'text-white/40' }
}

export function ActivityChip({ activity }: { activity: Activity }): React.JSX.Element {
  const mark = MARK[activity.status]
  const diff = diffLabel(activity)
  return (
    <span className="inline-flex max-w-[11.5rem] shrink-0 items-center gap-1 rounded-full bg-white/[0.07] px-2 py-0.5 text-[10.5px] text-white/65">
      <span className={mark.tone}>{mark.sign}</span>
      <span className="truncate">{activityLabel(activity)}</span>
      {diff && <span className="shrink-0 text-white/45">{diff}</span>}
    </span>
  )
}
