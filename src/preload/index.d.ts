import type { SuriApi } from '../shared/ipc'

declare global {
  interface Window {
    suri: SuriApi
  }
}

export {}
