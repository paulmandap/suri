import { motion, useReducedMotion } from 'motion/react'
import type { Session } from '@shared/types'
import { statsLabel } from '../lib/format'
import type { Mood } from '../lib/format'
import { PlaceholderMascot } from '../mascot/PlaceholderMascot'
import { only } from '../lib/only'

interface CardProps {
  session: Session
  onDismiss: () => void
}

/**
 * Claude Code wants permission. ADR-007: calm and cute, like the demo. The
 * meerkat jumps into its lookout pose and a "!" pops up. Answering happens in
 * Claude Code until approvals land in Phase 2.
 */
export function WaitingCard({ session, onDismiss }: CardProps): React.JSX.Element {
  const pending = session.pendingPermission
  return (
    <div className="flex h-full items-center gap-3.5 px-4">
      <CardMascot mood="alert" jump badge="!" badgeTone="bg-amber-400 text-black" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="font-semibold">{session.project}</span>
          <span className="text-amber-300">needs your OK</span>
        </div>
        <div className="mt-1.5 truncate rounded-lg bg-white/[0.07] px-2 py-1 font-mono text-[12px] text-amber-50">
          {pending?.target || pending?.tool}
        </div>
        <div className="mt-1.5 text-[11px] text-white/45">
          {pending?.tool} · answer in Claude Code
        </div>
      </div>
      <button
        type="button"
        onClick={only(onDismiss)}
        className="shrink-0 rounded-full bg-white/10 px-3.5 py-1.5 text-[12px] hover:bg-white/15"
      >
        OK
      </button>
    </div>
  )
}

export function FinishedCard({
  session,
  onDismiss,
  onOpen
}: CardProps & { onOpen: (sessionId: string) => void }): React.JSX.Element {
  return (
    <div className="flex h-full items-center gap-3.5 px-4">
      <CardMascot mood="happy" jump />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="font-semibold">{session.project}</span>
          <span className="text-emerald-300">finished</span>
        </div>
        <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-white/80">
          {session.lastMessage ?? 'Claude Code is done.'}
        </div>
        <div className="mt-1 text-[11px] text-white/40">{statsLabel(session)}</div>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        <button
          type="button"
          onClick={only(() => onOpen(session.id))}
          className="rounded-full bg-white px-3.5 py-1.5 text-[12px] font-medium text-black hover:bg-white/90"
        >
          Open
        </button>
        <button
          type="button"
          onClick={only(onDismiss)}
          className="rounded-full bg-white/10 px-3.5 py-1.5 text-[12px] hover:bg-white/15"
        >
          OK
        </button>
      </div>
    </div>
  )
}

export function ErrorCard({ session, onDismiss }: CardProps): React.JSX.Element {
  return (
    <div className="flex h-full items-center gap-3.5 px-4">
      <CardMascot mood="worried" badge="✕" badgeTone="bg-red-400 text-black" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="font-semibold">{session.project}</span>
          <span className="text-red-300">stopped with an error</span>
        </div>
        <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-white/80">
          {session.errorMessage ?? 'Claude Code stopped with an error.'}
        </div>
      </div>
      <button
        type="button"
        onClick={only(onDismiss)}
        className="shrink-0 rounded-full bg-white/10 px-3.5 py-1.5 text-[12px] hover:bg-white/15"
      >
        OK
      </button>
    </div>
  )
}

function CardMascot({
  mood,
  jump = false,
  badge,
  badgeTone = ''
}: {
  mood: Mood
  jump?: boolean
  badge?: string
  badgeTone?: string
}): React.JSX.Element {
  const reduce = useReducedMotion() ?? false
  return (
    <div className="relative shrink-0">
      <motion.div
        initial={{ y: 0 }}
        animate={jump && !reduce ? { y: [0, -9, 0, -4, 0] } : { y: 0 }}
        transition={{ duration: 0.9, ease: 'easeOut', delay: 0.15 }}
      >
        <PlaceholderMascot mood={mood} size={46} />
      </motion.div>
      {badge && (
        <motion.div
          className={`absolute -right-1.5 -top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] font-black shadow ${badgeTone}`}
          initial={{ scale: 0, rotate: -20 }}
          animate={reduce ? { scale: 1, rotate: 0 } : { scale: [0, 1.25, 1], rotate: [-20, 12, 0] }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          {badge}
        </motion.div>
      )}
    </div>
  )
}
