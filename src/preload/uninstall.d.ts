import type { SuriUninstallApi } from '../shared/uninstall-ipc'

declare global {
  interface Window {
    /** Only in the Uninstall window (src/preload/uninstall.ts). */
    suriUninstall: SuriUninstallApi
  }
}

export {}
