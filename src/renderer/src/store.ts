import { create } from 'zustand'
import { pickFocus, type DecisionFeedback, type IslandUiState } from '@shared/island-mode'
import type { IslandSnapshot } from '@shared/types'

/** How long "Allowed / Denied" shows before the island moves on. */
const FEEDBACK_MS = 900

interface IslandStore {
  snapshot: IslandSnapshot | null
  ui: IslandUiState
  setSnapshot: (snapshot: IslandSnapshot) => void
  setHovering: (hovering: boolean) => void
  setPinnedOpen: (pinnedOpen: boolean) => void
  dismiss: (cardKey: string) => void
  showFeedback: (feedback: DecisionFeedback) => void
}

let feedbackTimer: ReturnType<typeof setTimeout> | undefined

export const useIsland = create<IslandStore>((set) => ({
  snapshot: null,
  ui: { hovering: false, pinnedOpen: false, dismissed: {} },
  setSnapshot: (snapshot) =>
    set((s) => {
      const focus = pickFocus(s.ui.focus, snapshot.sessions, Date.now())
      return { snapshot, ui: focus === s.ui.focus ? s.ui : { ...s.ui, focus } }
    }),
  setHovering: (hovering) =>
    set((s) => (s.ui.hovering === hovering ? s : { ui: { ...s.ui, hovering } })),
  setPinnedOpen: (pinnedOpen) =>
    set((s) => (s.ui.pinnedOpen === pinnedOpen ? s : { ui: { ...s.ui, pinnedOpen } })),
  dismiss: (cardKey) =>
    set((s) => ({ ui: { ...s.ui, dismissed: { ...s.ui.dismissed, [cardKey]: true } } })),
  showFeedback: (feedback) => {
    clearTimeout(feedbackTimer)
    set((s) => ({ ui: { ...s.ui, feedback } }))
    feedbackTimer = setTimeout(
      () =>
        set((s) =>
          s.ui.feedback?.id === feedback.id ? { ui: { ...s.ui, feedback: undefined } } : s
        ),
      FEEDBACK_MS
    )
  }
}))
