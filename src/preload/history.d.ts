import type { SuriHistoryApi } from '../shared/history-ipc'

declare global {
  interface Window {
    /** Only in the History window (src/preload/history.ts). */
    suriHistory: SuriHistoryApi
  }
}

export {}
