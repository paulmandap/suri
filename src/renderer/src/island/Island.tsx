import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react'
import { useCallback, useEffect, useRef } from 'react'
import { cardKey, deriveIslandView, islandCardKey, type IslandView } from '@shared/island-mode'
import type { ApprovalDecision, IslandSnapshot, PendingApproval } from '@shared/types'
import { useNow } from '../lib/useNow'
import { useIsland } from '../store'
import { ApprovalCard, FeedbackCard } from '../views/ApprovalCard'
import { CompactView } from '../views/CompactView'
import { ErrorCard, FinishedCard, WaitingCard } from '../views/Cards'
import { ExpandedView } from '../views/ExpandedView'
import { PeekView } from '../views/PeekView'
import { islandShape } from './shapes'
import { usePointerZone } from './usePointerZone'

// The Dynamic Island feel (ADR-006): the shape springs with a little
// overshoot; the content waits for it, fades in, and leaves before it shrinks.
const SPRING: Transition = { type: 'spring', stiffness: 380, damping: 30, mass: 0.9 }
const REDUCED: Transition = { duration: 0.15 }

// Where the pointer wakes a hidden island: a thin strip at the top centre.
const HOT_ZONE_WIDTH = 300
const HOT_ZONE_HEIGHT = 10

export function Island(): React.JSX.Element {
  const snapshot = useIsland((s) => s.snapshot)
  const ui = useIsland((s) => s.ui)
  const setHovering = useIsland((s) => s.setHovering)
  const setPinnedOpen = useIsland((s) => s.setPinnedOpen)
  const dismiss = useIsland((s) => s.dismiss)
  const showFeedback = useIsland((s) => s.showFeedback)
  const reduce = useReducedMotion() ?? false

  const sessionCount = snapshot?.sessions.length ?? 0
  const busy = sessionCount > 0 || (snapshot?.approvals.length ?? 0) > 0
  const now = useNow(busy || ui.hovering || ui.pinnedOpen)
  const view = deriveIslandView(snapshot, ui, now)
  const shape = islandShape(view, sessionCount)
  const ref = useRef<HTMLDivElement>(null)

  const getZone = useCallback((): DOMRect | null => {
    const el = ref.current
    if (!el) return null
    if (el.dataset.mode === 'hidden') {
      return new DOMRect(
        (window.innerWidth - HOT_ZONE_WIDTH) / 2,
        0,
        HOT_ZONE_WIDTH,
        HOT_ZONE_HEIGHT
      )
    }
    const r = el.getBoundingClientRect()
    return new DOMRect(r.left - 6, 0, r.width + 12, r.bottom + 6)
  }, [])

  // A short delay in and a longer one out, so a passing pointer doesn't pop it open.
  const intent = useRef<number | undefined>(undefined)
  const onZone = useCallback(
    (inside: boolean) => {
      window.clearTimeout(intent.current)
      intent.current = window.setTimeout(
        () => {
          setHovering(inside)
          if (!inside) setPinnedOpen(false)
        },
        inside ? 160 : 420
      )
    },
    [setHovering, setPinnedOpen]
  )
  usePointerZone(getZone, onZone)

  // Opened from the tray but never visited: fold back after a while.
  useEffect(() => {
    if (!ui.pinnedOpen || ui.hovering) return
    const id = window.setTimeout(() => setPinnedOpen(false), 6000)
    return () => window.clearTimeout(id)
  }, [ui.pinnedOpen, ui.hovering, setPinnedOpen])

  const openSession = useCallback((sessionId: string) => {
    void window.suri.openSession(sessionId)
  }, [])

  const decide = useCallback(
    (approval: PendingApproval, decision: ApprovalDecision) => {
      void window.suri.decideApproval(approval.id, decision)
      if (decision !== 'ask') {
        showFeedback({ id: approval.id, decision, project: approval.project })
      }
    },
    [showFeedback]
  )

  const onShapeClick = (): void => {
    if (view.mode === 'peek' || view.mode === 'compact') setPinnedOpen(true)
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 flex justify-center">
      <motion.div
        ref={ref}
        data-mode={view.mode}
        onClick={onShapeClick}
        className="pointer-events-auto relative overflow-hidden text-white"
        initial={false}
        animate={{
          width: shape.width,
          height: shape.height,
          borderBottomLeftRadius: shape.radius,
          borderBottomRightRadius: shape.radius,
          backgroundColor: shape.background,
          boxShadow: shape.glow,
          opacity: view.mode === 'hidden' ? 0 : 1
        }}
        transition={reduce ? REDUCED : SPRING}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view.card ? islandCardKey(view.card) : view.mode}
            className="absolute inset-0"
            initial={{ opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
            animate={{
              opacity: 1,
              scale: 1,
              filter: 'blur(0px)',
              transition: { delay: reduce ? 0 : 0.1, duration: 0.22 }
            }}
            exit={{ opacity: 0, scale: 0.98, filter: 'blur(3px)', transition: { duration: 0.1 } }}
          >
            <IslandContent
              view={view}
              snapshot={snapshot}
              now={now}
              onOpen={openSession}
              onDismiss={dismiss}
              onDecide={decide}
            />
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

function IslandContent({
  view,
  snapshot,
  now,
  onOpen,
  onDismiss,
  onDecide
}: {
  view: IslandView
  snapshot: IslandSnapshot | null
  now: number
  onOpen: (sessionId: string) => void
  onDismiss: (cardKey: string) => void
  onDecide: (approval: PendingApproval, decision: ApprovalDecision) => void
}): React.JSX.Element | null {
  switch (view.mode) {
    case 'hidden':
      return null
    case 'peek':
      return <PeekView snapshot={snapshot} />
    case 'compact':
      return view.focus ? (
        <CompactView session={view.focus} count={snapshot?.sessions.length ?? 1} />
      ) : null
    case 'expanded':
      return <ExpandedView snapshot={snapshot} now={now} onOpen={onOpen} />
    case 'card': {
      const card = view.card
      if (!card) return null
      if (card.kind === 'approval') {
        return (
          <ApprovalCard
            approval={card.approval}
            queued={card.queued}
            now={now}
            onDecide={(decision) => onDecide(card.approval, decision)}
          />
        )
      }
      if (card.kind === 'feedback') return <FeedbackCard feedback={card.feedback} />
      const close = (): void => onDismiss(cardKey(card.kind, card.session))
      if (card.kind === 'waiting') return <WaitingCard session={card.session} onDismiss={close} />
      if (card.kind === 'error') return <ErrorCard session={card.session} onDismiss={close} />
      return <FinishedCard session={card.session} onDismiss={close} onOpen={onOpen} />
    }
  }
}
