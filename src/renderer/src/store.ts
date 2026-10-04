import { create } from 'zustand'
import type { IslandUiState } from '@shared/island-mode'
import type { IslandSnapshot } from '@shared/types'

interface IslandStore {
  snapshot: IslandSnapshot | null
  ui: IslandUiState
  setSnapshot: (snapshot: IslandSnapshot) => void
  setHovering: (hovering: boolean) => void
  setPinnedOpen: (pinnedOpen: boolean) => void
  dismiss: (cardKey: string) => void
}

export const useIsland = create<IslandStore>((set) => ({
  snapshot: null,
  ui: { hovering: false, pinnedOpen: false, dismissed: {} },
  setSnapshot: (snapshot) => set({ snapshot }),
  setHovering: (hovering) =>
    set((s) => (s.ui.hovering === hovering ? s : { ui: { ...s.ui, hovering } })),
  setPinnedOpen: (pinnedOpen) =>
    set((s) => (s.ui.pinnedOpen === pinnedOpen ? s : { ui: { ...s.ui, pinnedOpen } })),
  dismiss: (cardKey) =>
    set((s) => ({ ui: { ...s.ui, dismissed: { ...s.ui.dismissed, [cardKey]: true } } }))
}))
