import type { HookInspection } from './hook-config'
import type { ApplyHooksResult, PreviewResult } from './settings-ipc'

// The Uninstall window (ADR-031): `suri --uninstall`, opened by the Windows
// uninstaller before it deletes the app. Its own channels and its own small
// API, like Settings (ADR-014). Types only besides the channel names: the
// sandboxed preload imports this.

export const UNINSTALL_IPC = {
  /** renderer → main (invoke): the UninstallView. */
  getView: 'suri:uninstall-get-view',
  /** renderer → main (invoke): work out the removal of Suri's hooks, writing nothing. */
  previewRemoval: 'suri:uninstall-preview-removal',
  /** renderer → main (invoke): write the previewed removal. Only a click can send it. */
  applyRemoval: 'suri:uninstall-apply-removal',
  /** renderer → main (invoke): delete Suri's data if asked, then quit. Only a click can send it. */
  finish: 'suri:uninstall-finish'
} as const

export interface UninstallView {
  /** Claude Code's user settings, and Suri's hooks in it. */
  hooks: { file: string; exists: boolean; inspection: HookInspection }
  /** Suri's folder: its settings, the history and the saved Gemini key. */
  data: { folder: string; exists: boolean }
}

export type FinishResult = { ok: true } | { ok: false; message: string }

/** The only API the Uninstall window gets (`window.suriUninstall`). */
export interface SuriUninstallApi {
  getView(): Promise<UninstallView>
  previewRemoval(): Promise<PreviewResult>
  applyRemoval(previewId: string): Promise<ApplyHooksResult>
  /** Deletes Suri's data when `deleteData` is true, then closes. Refused unless a click started it. */
  finish(deleteData: boolean): Promise<FinishResult>
}
