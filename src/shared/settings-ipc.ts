import type { AiPatch, AiSettings, ConnectionTest, ProviderId } from './ai-config'
import type { HookAction, HookInspection } from './hook-config'
import type { DiffLine } from './line-diff'
import type { GeneralPatch } from './settings-schemas'
import type { HookServerStatus } from './types'

// The Settings window talks to main over its own channels; the island can't
// call them, and the Settings window can't call the island's (ADR-014).
// Types only besides the channel names: the sandboxed preload imports this.

export const SETTINGS_IPC = {
  /** renderer → main (invoke): the current SettingsView. */
  getView: 'suri:settings-get-view',
  /** main → renderer: a fresh SettingsView after any change. */
  view: 'suri:settings-view',
  /** renderer → main (invoke): change a General setting. Resolves to an UpdateResult. */
  updateGeneral: 'suri:settings-update-general',
  /** renderer → main (invoke): work out an install or uninstall without writing anything. */
  previewHooks: 'suri:settings-preview-hooks',
  /** renderer → main (invoke): write the previewed change. Only a click can send it. */
  applyHooks: 'suri:settings-apply-hooks',
  /** renderer → main (invoke): show settings.json, the newest backup or the history in Explorer. */
  reveal: 'suri:settings-reveal',
  /** renderer → main (invoke): change the AI settings (Ollama address, models per feature). */
  updateAi: 'suri:settings-update-ai',
  /** renderer → main (invoke): "Test connection" for Ollama or Gemini. */
  testAi: 'suri:settings-test-ai',
  /** renderer → main (invoke): save the Gemini key, encrypted. It never comes back. */
  saveGeminiKey: 'suri:settings-save-gemini-key',
  /** renderer → main (invoke): delete the saved Gemini key. */
  removeGeminiKey: 'suri:settings-remove-gemini-key',
  /** renderer → main (invoke): start Ollama's app if it isn't running. */
  startOllama: 'suri:settings-start-ollama',
  /** renderer → main (invoke): delete everything in the history. Only a click can send it. */
  deleteHistory: 'suri:settings-delete-history'
} as const

export interface GeneralView {
  port: number
  hideFromCapture: boolean
  safetyNet: boolean
  openAtLogin: boolean
  /** Only the installed app can start with Windows; a dev build would register electron.exe. */
  canOpenAtLogin: boolean
  soundNeedsYou: boolean
  soundFinished: boolean
  recaps: boolean
  /** Suri's history database, or why it couldn't be opened. */
  history: { file: string; ok: boolean; message?: string }
}

export interface HooksView {
  /** Claude Code's user settings file (~/.claude/settings.json). */
  file: string
  exists: boolean
  /** Where Suri's hooks send events. */
  url: string
  inspection: HookInspection
  /** The newest backup Suri made since it started. */
  lastBackup: string | null
}

export interface AiView {
  settings: AiSettings
  /** Whether a Gemini key is saved. The key itself never reaches the page. */
  geminiKey: 'saved' | 'missing'
  /** Windows can encrypt secrets (DPAPI); without it Suri won't save a key. */
  secureStorage: boolean
  /** Ollama's app is installed, so "Start Ollama" can work. */
  ollamaApp: boolean
}

export interface SettingsView {
  general: GeneralView
  server: HookServerStatus
  hooks: HooksView
  ai: AiView
}

export type UpdateResult = { ok: true } | { ok: false; message: string }

export interface HookPreview {
  id: string
  action: HookAction
  /** False when the file already says what the action would write. */
  changed: boolean
  /** The diff, with secrets masked. */
  lines: DiffLine[]
  added: number
  removed: number
  /** Suri's hooks in the file now, and after the change. */
  suriBefore: number
  suriAfter: number
  /** Other tools' hooks, which stay as they are. */
  otherHooks: number
  /** Where the dated backup goes, or null when there's no file to back up. */
  backupHint: string | null
}

export type PreviewResult = { ok: true; preview: HookPreview } | { ok: false; message: string }

/**
 * `changed`: settings.json changed after the preview. `stale`: the preview was
 * replaced, used, or Suri's port changed. `no-click`: not started by a click.
 */
export type ApplyHooksResult =
  | { ok: true; backup: string | null }
  | { ok: false; reason: 'changed' | 'stale' | 'no-click' | 'failed'; message: string }

export type RevealTarget = 'settings-file' | 'last-backup' | 'history-file'

/** The only API the Settings window gets (`window.suriSettings`). */
export interface SuriSettingsApi {
  getView(): Promise<SettingsView>
  onView(callback: (view: SettingsView) => void): () => void
  updateGeneral(patch: GeneralPatch): Promise<UpdateResult>
  previewHooks(action: HookAction): Promise<PreviewResult>
  applyHooks(previewId: string): Promise<ApplyHooksResult>
  reveal(target: RevealTarget): Promise<boolean>
  updateAi(patch: AiPatch): Promise<UpdateResult>
  testAi(provider: ProviderId): Promise<ConnectionTest>
  saveGeminiKey(key: string): Promise<UpdateResult>
  removeGeminiKey(): Promise<UpdateResult>
  startOllama(): Promise<UpdateResult>
  /** Deletes every turn, recap, approval and digest. Refused unless a click started it. */
  deleteHistory(): Promise<UpdateResult>
}
