import { AnimatePresence, motion } from 'motion/react'
import type { Session } from '@shared/types'
import { headline, moodFor } from '../lib/format'
import { MascotHead } from '../mascot/Mascot'
import { StatusDot } from './parts'

export function CompactView({
  session,
  count
}: {
  session: Session
  count: number
}): React.JSX.Element {
  const line = headline(session)
  return (
    <div className="flex h-full items-center gap-2.5 px-3.5">
      <MascotHead mood={moodFor(session.status)} size={28} pop />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[12.5px] leading-tight">
        <span className="shrink-0 font-semibold">{session.project}</span>
        <span className="shrink-0 text-white/30">·</span>
        {/* Each new step slides in like a ticker. */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={line}
              className="block truncate text-white/75"
              initial={{ opacity: 0, y: 9 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -9 }}
              transition={{ duration: 0.2 }}
            >
              {line}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
      <StatusDot status={session.status} />
      {count > 1 && (
        <span className="shrink-0 rounded-full bg-white/10 px-1.5 text-[10px] text-white/70">
          {count}
        </span>
      )}
    </div>
  )
}
