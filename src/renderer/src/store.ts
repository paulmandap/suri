import { create } from 'zustand'
import type { AskEvent, DocumentInfo } from '@shared/file-qa'
import { pickFocus, type DecisionFeedback, type IslandUiState } from '@shared/island-mode'
import type { IslandSnapshot } from '@shared/types'

/** How long "Allowed / Denied" shows before the island moves on. */
const FEEDBACK_MS = 900

/** One question about the file, and its answer as it arrives. */
export interface AskMessage {
  id: string
  question: string
  answer: string
  state: 'streaming' | 'done' | 'error' | 'stopped'
  model?: string
  fellBackFrom?: string
  /** Only the matching parts of the file were sent. */
  partial?: boolean
  error?: string
}

/**
 * The file panel (ADR-027). Kept here, not in the panel, so an approval card
 * can take over the island for a moment without losing the conversation.
 */
export interface AskState {
  doc: DocumentInfo | null
  /** A file is being read. */
  loading: string | null
  /** Why the last file or question failed. */
  error: string | null
  messages: AskMessage[]
}

const NO_ASK: AskState = { doc: null, loading: null, error: null, messages: [] }

interface IslandStore {
  snapshot: IslandSnapshot | null
  ui: IslandUiState
  ask: AskState
  setSnapshot: (snapshot: IslandSnapshot) => void
  setHovering: (hovering: boolean) => void
  setPinnedOpen: (pinnedOpen: boolean) => void
  dismiss: (cardKey: string) => void
  showFeedback: (feedback: DecisionFeedback) => void
  openAsk: () => void
  /** Closes the panel and forgets the file and the conversation. */
  closeAsk: () => void
  setAsk: (patch: Partial<AskState>) => void
  addQuestion: (id: string, question: string) => void
  applyAskEvent: (event: AskEvent) => void
  stopAnswer: (id: string) => void
}

let feedbackTimer: ReturnType<typeof setTimeout> | undefined

const updateMessage = (
  messages: AskMessage[],
  id: string,
  change: (message: AskMessage) => AskMessage
): AskMessage[] => messages.map((m) => (m.id === id ? change(m) : m))

export const useIsland = create<IslandStore>((set) => ({
  snapshot: null,
  ui: { hovering: false, pinnedOpen: false, dismissed: {} },
  ask: NO_ASK,
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
  },
  openAsk: () => set((s) => (s.ui.askOpen ? s : { ui: { ...s.ui, askOpen: true } })),
  closeAsk: () => set((s) => ({ ui: { ...s.ui, askOpen: false, pinnedOpen: false }, ask: NO_ASK })),
  setAsk: (patch) => set((s) => ({ ask: { ...s.ask, ...patch } })),
  addQuestion: (id, question) =>
    set((s) => ({
      ask: {
        ...s.ask,
        error: null,
        messages: [...s.ask.messages, { id, question, answer: '', state: 'streaming' }]
      }
    })),
  applyAskEvent: (event) =>
    set((s) => {
      const known = s.ask.messages.some((m) => m.id === event.id && m.state === 'streaming')
      if (!known) return s
      const messages = updateMessage(s.ask.messages, event.id, (m) =>
        event.type === 'chunk'
          ? { ...m, answer: m.answer + event.text }
          : event.type === 'done'
            ? {
                ...m,
                state: 'done',
                model: event.model,
                partial: event.partial,
                ...(event.fellBackFrom ? { fellBackFrom: event.fellBackFrom } : {})
              }
            : { ...m, state: 'error', error: event.message }
      )
      return { ask: { ...s.ask, messages } }
    }),
  stopAnswer: (id) =>
    set((s) => ({
      ask: {
        ...s.ask,
        messages: updateMessage(s.ask.messages, id, (m) =>
          m.state === 'streaming' ? { ...m, state: 'stopped' } : m
        )
      }
    }))
}))
