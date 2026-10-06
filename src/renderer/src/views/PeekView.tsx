import type { IslandSnapshot } from '@shared/types'
import { MascotHead } from '../mascot/Mascot'

/** Why Claude Code's events might not reach Suri, and where to fix it. */
const HOOKS_NOTE = {
  'not-installed': 'Hooks not installed · tray → Settings',
  outdated: 'Hooks need an update · tray → Settings',
  unreadable: "Can't read Claude Code settings · tray → Settings"
} as const

export function PeekView({ snapshot }: { snapshot: IslandSnapshot | null }): React.JSX.Element {
  const server = snapshot?.hookServer
  const broken = server?.state === 'error'
  const hooksNote = snapshot && snapshot.hooks !== 'installed' ? HOOKS_NOTE[snapshot.hooks] : null
  const status = !snapshot
    ? 'Starting…'
    : snapshot.paused
      ? 'Paused'
      : server?.state === 'error'
        ? server.message
        : (hooksNote ?? 'Watching for Claude Code')
  const tone = broken ? 'text-red-300' : hooksNote ? 'text-amber-200/80' : 'text-white/55'
  return (
    <div className="flex h-full items-center gap-2.5 px-4">
      <MascotHead mood={snapshot?.paused ? 'sleepy' : broken ? 'worried' : 'idle'} size={28} pop />
      <div className="min-w-0 leading-tight">
        <div className="text-[13px] font-semibold">Suri</div>
        <div className={`truncate text-[11px] ${tone}`}>{status}</div>
      </div>
    </div>
  )
}
