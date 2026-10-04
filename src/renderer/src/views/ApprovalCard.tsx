import { motion, useReducedMotion } from 'motion/react'
import type { DecisionFeedback } from '@shared/island-mode'
import type { ApprovalDecision, PendingApproval, RiskFlag } from '@shared/types'
import { formatCountdown, wantsTo } from '../lib/format'
import { only } from '../lib/only'
import { PlaceholderMascot } from '../mascot/PlaceholderMascot'
import { CardMascot } from './Cards'

interface Props {
  approval: PendingApproval
  queued: number
  now: number
  onDecide: (decision: ApprovalDecision) => void
}

/**
 * Claude Code is waiting on Paul (ADR-007): the meerkat jumps to attention,
 * a soft ring breathes around the card, and the exact command is shown
 * before anything runs.
 */
export function ApprovalCard({ approval, queued, now, onDecide }: Props): React.JSX.Element {
  const reduce = useReducedMotion() ?? false
  const high = approval.risk?.level === 'high'
  const ring = high ? 'ring-red-400/60' : 'ring-amber-300/50'
  const allowTone = high ? 'bg-amber-300 hover:bg-amber-200' : 'bg-white hover:bg-white/90'
  return (
    <div className="relative flex h-full gap-3.5 px-4 pb-3 pt-3.5">
      <motion.div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ${ring}`}
        animate={reduce ? { opacity: 0.6 } : { opacity: [0.2, 0.85, 0.2] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
      />
      <CardMascot
        mood="alert"
        jump
        badge="!"
        badgeTone={high ? 'bg-red-400 text-black' : 'bg-amber-400 text-black'}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="font-semibold">{approval.project}</span>
          <span className={high ? 'text-red-300' : 'text-amber-300'}>
            wants to {wantsTo(approval.verb, approval.tool)}
          </span>
          <span className="rounded-full bg-white/10 px-1.5 text-[10px] text-white/60">
            {approval.tool}
          </span>
          {queued > 0 && (
            <span className="ml-auto shrink-0 text-[10.5px] text-white/45">+{queued} waiting</span>
          )}
        </div>
        <div className="mt-1.5 max-h-[38px] select-text overflow-y-auto break-all rounded-lg bg-white/[0.07] px-2 py-1 font-mono text-[11.5px] leading-snug text-amber-50">
          {approval.detail}
        </div>
        {approval.risk && <RiskLine risk={approval.risk} />}
        <div className="mt-auto flex items-center gap-2.5 pt-1.5">
          <button
            type="button"
            onClick={only(() => onDecide('ask'))}
            className="text-[11px] text-white/45 underline-offset-2 hover:text-white/75 hover:underline"
          >
            Ask in Claude Code
          </button>
          <span className="text-[10.5px] tabular-nums text-white/30">
            {formatCountdown(approval.expiresAt - now)}
          </span>
          <div className="ml-auto flex gap-1.5">
            <button
              type="button"
              onClick={only(() => onDecide('deny'))}
              className="rounded-full bg-white/10 px-4 py-1.5 text-[12px] hover:bg-red-500/35"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={only(() => onDecide('allow'))}
              className={`rounded-full px-4 py-1.5 text-[12px] font-medium text-black ${allowTone}`}
            >
              Allow
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RiskLine({ risk }: { risk: RiskFlag }): React.JSX.Element {
  const high = risk.level === 'high'
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px]">
      <span className={`shrink-0 font-semibold ${high ? 'text-red-300' : 'text-amber-200'}`}>
        {high ? 'High risk' : 'Careful'}
      </span>
      <span className="truncate text-white/60">{risk.reason}</span>
    </div>
  )
}

/** The short moment after a click: a happy hop for Allow, a worried face for Deny. */
export function FeedbackCard({ feedback }: { feedback: DecisionFeedback }): React.JSX.Element {
  const allowed = feedback.decision === 'allow'
  return (
    <div className="flex h-full items-center justify-center gap-2.5 px-4">
      <motion.div
        initial={{ scale: 0.6, rotate: -12 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 520, damping: 16 }}
      >
        <PlaceholderMascot mood={allowed ? 'happy' : 'worried'} size={30} />
      </motion.div>
      <span
        className={`text-[13px] font-semibold ${allowed ? 'text-emerald-300' : 'text-red-300'}`}
      >
        {allowed ? 'Allowed' : 'Denied'}
      </span>
      <span className="truncate text-[12px] text-white/50">{feedback.project}</span>
    </div>
  )
}
