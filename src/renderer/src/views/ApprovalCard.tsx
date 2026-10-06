import { motion, useReducedMotion } from 'motion/react'
import { approvalLevel, type DecisionFeedback } from '@shared/island-mode'
import type { ApprovalDecision, PendingApproval, RiskLevel } from '@shared/types'
import { formatCountdown, riskModelLabel, wantsTo } from '../lib/format'
import { only } from '../lib/only'
import { MascotBody } from '../mascot/Mascot'
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
  const level = approvalLevel(approval)
  const high = level === 'high'
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
        // High risk: Suri raises its shield (ADR-019).
        pose={high ? 'shield' : 'alert'}
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
        <RiskBlock approval={approval} level={level} />
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

const LEVEL: Record<RiskLevel, { label: string; tone: string }> = {
  high: { label: 'High risk', tone: 'text-red-300' },
  medium: { label: 'Careful', tone: 'text-amber-200' },
  low: { label: 'Low risk', tone: 'text-emerald-300' }
}

/**
 * The rule's verdict at once, then the AI's plain-English explanation as it
 * arrives (ADR-016). The badge shows the higher of the two levels.
 */
function RiskBlock({
  approval,
  level
}: {
  approval: PendingApproval
  level: RiskLevel | undefined
}): React.JSX.Element {
  const reduce = useReducedMotion() ?? false
  const { risk, explanation, checkingRisk, riskNote } = approval
  // Without a rule, the AI's summary takes the rule's place next to the badge.
  const headline = risk?.reason ?? explanation?.summary
  return (
    <div className="mt-1.5 min-w-0 text-[11px] leading-snug">
      {level && headline && (
        <div className="flex min-w-0 items-baseline gap-1.5">
          <motion.span
            // A new key when the AI raises the level, so the badge pops again.
            key={level}
            className={`shrink-0 font-semibold ${LEVEL[level].tone}`}
            initial={reduce ? false : { scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 18 }}
          >
            {LEVEL[level].label}
          </motion.span>
          <span
            className={`min-w-0 ${risk ? 'truncate text-white/60' : 'line-clamp-2 text-white/80'}`}
          >
            {headline}
          </span>
        </div>
      )}
      {risk && explanation && (
        <div className="mt-0.5 line-clamp-2 text-white/80">{explanation.summary}</div>
      )}
      {explanation && (
        <div className="mt-0.5 flex min-w-0 gap-1.5 text-[10px] text-white/35">
          <span className="shrink-0">
            {explanation.reversible ? 'Can be undone' : "Can't be undone"}
          </span>
          {explanation.reasons[0] && (
            <span className="min-w-0 truncate" title={explanation.reasons.join('\n')}>
              · {explanation.reasons[0]}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono">{riskModelLabel(explanation)}</span>
        </div>
      )}
      {checkingRisk && (
        <motion.div
          className="mt-0.5 text-[10.5px] text-white/40"
          animate={reduce ? { opacity: 0.6 } : { opacity: [0.35, 0.8, 0.35] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          Suri is checking this…
        </motion.div>
      )}
      {!checkingRisk && !explanation && riskNote && (
        <div className="mt-0.5 truncate text-[10px] text-white/35" title={riskNote}>
          No AI check: {riskNote}
        </div>
      )}
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
        <MascotBody pose={allowed ? 'thumbs-up' : 'worried'} size={40} />
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
