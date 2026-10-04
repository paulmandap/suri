import type { IslandSnapshot } from '@shared/types'
import { PlaceholderMascot } from '../mascot/PlaceholderMascot'

export function PeekView({ snapshot }: { snapshot: IslandSnapshot | null }): React.JSX.Element {
  const server = snapshot?.hookServer
  const broken = server?.state === 'error'
  const status = !snapshot
    ? 'Starting…'
    : snapshot.paused
      ? 'Paused'
      : server?.state === 'error'
        ? server.message
        : 'Watching for Claude Code'
  return (
    <div className="flex h-full items-center gap-2.5 px-4">
      <PlaceholderMascot
        mood={snapshot?.paused ? 'sleepy' : broken ? 'worried' : 'idle'}
        size={26}
      />
      <div className="min-w-0 leading-tight">
        <div className="text-[13px] font-semibold">Suri</div>
        <div className={`truncate text-[11px] ${broken ? 'text-red-300' : 'text-white/55'}`}>
          {status}
        </div>
      </div>
    </div>
  )
}
