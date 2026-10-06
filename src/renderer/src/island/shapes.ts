import { approvalLevel, type IslandView } from '@shared/island-mode'

export interface IslandShape {
  width: number
  height: number
  /** Bottom corners only: the island hangs from the top edge of the screen. */
  radius: number
  background: string
  glow: string
}

// Every glow is a single shadow, so motion can animate between any two.
const NO_GLOW = '0px 0px 0px 0px rgba(0, 0, 0, 0)'
const SOFT = '0px 18px 40px -18px rgba(0, 0, 0, 0.85)'
const AMBER = '0px 16px 46px -12px rgba(251, 191, 36, 0.6)'
const RED = '0px 16px 46px -12px rgba(248, 113, 113, 0.5)'
const GREEN = '0px 16px 46px -14px rgba(52, 211, 153, 0.45)'

export const ROW_HEIGHT = 84
export const MAX_ROWS = 3
/**
 * One height whatever the risk check says, so Allow and Deny never move
 * under the pointer when the AI's answer arrives.
 */
export const APPROVAL_HEIGHT = 196

export function islandShape(view: IslandView, sessionCount: number): IslandShape {
  switch (view.mode) {
    case 'hidden':
      return { width: 170, height: 0, radius: 16, background: '#000000', glow: NO_GLOW }
    case 'peek':
      return { width: 236, height: 44, radius: 22, background: '#000000', glow: SOFT }
    case 'compact':
      return { width: 340, height: 44, radius: 22, background: '#000000', glow: SOFT }
    case 'expanded': {
      const rows = Math.min(MAX_ROWS, Math.max(1, sessionCount))
      const height = sessionCount === 0 ? 132 : 56 + rows * ROW_HEIGHT
      return { width: 560, height, radius: 30, background: '#000000', glow: SOFT }
    }
    case 'card':
      if (view.card?.kind === 'approval') {
        // Turns red when the AI finds a danger the rules missed.
        const high = approvalLevel(view.card.approval) === 'high'
        const height = APPROVAL_HEIGHT
        return high
          ? { width: 540, height, radius: 30, background: '#160806', glow: RED }
          : { width: 540, height, radius: 30, background: '#120c02', glow: AMBER }
      }
      if (view.card?.kind === 'feedback') {
        return view.card.feedback.decision === 'allow'
          ? { width: 300, height: 50, radius: 25, background: '#03100a', glow: GREEN }
          : { width: 300, height: 50, radius: 25, background: '#130505', glow: RED }
      }
      if (view.card?.kind === 'waiting') {
        return { width: 480, height: 128, radius: 30, background: '#120c02', glow: AMBER }
      }
      if (view.card?.kind === 'error') {
        return { width: 480, height: 128, radius: 30, background: '#130505', glow: RED }
      }
      return { width: 480, height: 128, radius: 30, background: '#03100a', glow: GREEN }
  }
}
