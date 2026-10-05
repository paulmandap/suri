import type { SuriSettingsApi } from '../shared/settings-ipc'

declare global {
  interface Window {
    /** Only in the Settings window (src/preload/settings.ts). */
    suriSettings: SuriSettingsApi
  }
}

export {}
