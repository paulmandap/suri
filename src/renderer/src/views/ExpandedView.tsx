import type { HookServerStatus, IslandSnapshot, Session } from '@shared/types'
import { formatElapsed, headline, moodFor, statusLabel } from '../lib/format'
import { MAX_ROWS } from '../island/shapes'
import { PlaceholderMascot } from '../mascot/PlaceholderMascot'
import { only } from '../lib/only'
import { ActivityChip, StatusDot } from './parts'

interface Props {
  snapshot: IslandSnapshot | null
  now: number
  onOpen: (sessionId: string) => void
}

export function ExpandedView({ snapshot, now, onOpen }: Props): React.JSX.Element {
  const sessions = snapshot?.sessions ?? []
  const hidden = sessions.length - MAX_ROWS
  return (
    <div className="flex h-full flex-col px-3 pb-3 pt-2.5">
      <div className="flex items-center gap-2 px-1.5 pb-1.5">
        <PlaceholderMascot mood={moodFor(sessions[0]?.status)} size={22} />
        <span className="text-[13px] font-semibold">Suri</span>
        <ServerNote server={snapshot?.hookServer} paused={snapshot?.paused ?? false} />
        <span className="ml-auto text-[11px] text-white/40">
          {sessions.length === 1 ? '1 session' : `${sessions.length} sessions`}
          {hidden > 0 ? ` · ${hidden} more` : ''}
        </span>
      </div>
      {sessions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="text-[13px] text-white/80">No Claude Code sessions yet</div>
          <div className="mt-1 text-[11px] text-white/45">
            {snapshot?.hooks === 'installed'
              ? 'Start Claude Code in any project and it shows up here.'
              : 'Install the hooks (tray → Settings) to see every Claude Code session.'}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5">
          {sessions.slice(0, MAX_ROWS).map((session) => (
            <SessionRow key={session.id} session={session} now={now} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

function SessionRow({
  session,
  now,
  onOpen
}: {
  session: Session
  now: number
  onOpen: (sessionId: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title="Open in VS Code"
      onClick={only(() => onOpen(session.id))}
      className="w-full rounded-2xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06]"
    >
      <div className="flex items-center gap-2">
        <StatusDot status={session.status} />
        <span className="truncate text-[13px] font-semibold">{session.project}</span>
        <span className="shrink-0 text-[11px] text-white/45">{statusLabel(session.status)}</span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-white/35">
          {formatElapsed(now - session.startedAt)}
        </span>
      </div>
      <div className="mt-0.5 truncate pl-4 text-[12px] text-white/70">{headline(session)}</div>
      {session.recent.length > 0 && (
        <div className="mt-1.5 flex gap-1.5 overflow-hidden pl-4">
          {session.recent.slice(0, 3).map((activity) => (
            <ActivityChip key={activity.id} activity={activity} />
          ))}
        </div>
      )}
    </button>
  )
}

function ServerNote({
  server,
  paused
}: {
  server: HookServerStatus | undefined
  paused: boolean
}): React.JSX.Element | null {
  if (paused) return <span className="text-[11px] text-white/45">Paused</span>
  if (server?.state === 'error') {
    return <span className="truncate text-[11px] text-red-300">{server.message}</span>
  }
  return null
}
