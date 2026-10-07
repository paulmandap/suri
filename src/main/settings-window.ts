import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { AiPatch, ConnectionTest, ProviderId } from '@shared/ai-config'
import type { HookAction } from '@shared/hook-config'
import {
  SETTINGS_IPC,
  type ApplyHooksResult,
  type PreviewResult,
  type RevealTarget,
  type SettingsView,
  type UpdateResult
} from '@shared/settings-ipc'
import {
  aiPatchSchema,
  generalPatchSchema,
  geminiKeySchema,
  hookActionSchema,
  previewIdSchema,
  providerSchema,
  revealTargetSchema,
  type GeneralPatch
} from '@shared/settings-schemas'
import iconPath from '../../resources/icon.png?asset'

const BACKGROUND = '#0b0b0e'

/**
 * The Settings window (ADR-014): an ordinary window that can take focus, with
 * the same lockdown as the island (sandbox, context isolation, no Node, its
 * own small preload).
 */
export function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 640,
    minWidth: 660,
    minHeight: 500,
    title: 'Suri Settings',
    show: false,
    backgroundColor: BACKGROUND,
    icon: iconPath,
    // A dark title bar drawn by the page; Windows still draws the caption buttons.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BACKGROUND, symbolColor: '#a1a1aa', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/settings.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.removeMenu()

  // Settings only ever shows its own page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.reload()
  })
  win.once('ready-to-show', () => win.show())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/settings.html'))
  }
  if (process.env['SURI_DEVTOOLS'] === '1') win.webContents.openDevTools({ mode: 'detach' })
  return win
}

export interface SettingsHandlers {
  /** Only the Settings window may use these channels. */
  isSettings(sender: WebContents): boolean
  view(): SettingsView
  updateGeneral(patch: GeneralPatch): Promise<UpdateResult>
  previewHooks(action: HookAction): Promise<PreviewResult>
  applyHooks(previewId: string): Promise<ApplyHooksResult>
  reveal(target: RevealTarget): Promise<boolean>
  updateAi(patch: AiPatch): Promise<UpdateResult>
  testAi(provider: ProviderId): Promise<ConnectionTest>
  saveGeminiKey(key: string): Promise<UpdateResult>
  removeGeminiKey(): Promise<UpdateResult>
  startOllama(): Promise<UpdateResult>
  deleteHistory(): Promise<UpdateResult>
}

/** Main checks who sent each message and what is in it; the page is never trusted. */
export function registerSettingsIpc(h: SettingsHandlers): void {
  ipcMain.handle(SETTINGS_IPC.getView, (event) => (h.isSettings(event.sender) ? h.view() : null))

  ipcMain.handle(SETTINGS_IPC.updateGeneral, (event, patch: unknown): Promise<UpdateResult> => {
    const parsed = generalPatchSchema.safeParse(patch)
    if (!h.isSettings(event.sender) || !parsed.success) {
      return Promise.resolve({ ok: false, message: 'That setting is not valid.' })
    }
    return h.updateGeneral(parsed.data)
  })

  ipcMain.handle(SETTINGS_IPC.previewHooks, (event, action: unknown): Promise<PreviewResult> => {
    const parsed = hookActionSchema.safeParse(action)
    if (!h.isSettings(event.sender) || !parsed.success) {
      return Promise.resolve({ ok: false, message: 'That action is not valid.' })
    }
    return h.previewHooks(parsed.data)
  })

  ipcMain.handle(SETTINGS_IPC.applyHooks, (event, id: unknown): Promise<ApplyHooksResult> => {
    const parsed = previewIdSchema.safeParse(id)
    if (!h.isSettings(event.sender) || !parsed.success) {
      return Promise.resolve({ ok: false, reason: 'stale', message: 'That preview is not valid.' })
    }
    return h.applyHooks(parsed.data)
  })

  ipcMain.handle(SETTINGS_IPC.reveal, (event, target: unknown): Promise<boolean> => {
    const parsed = revealTargetSchema.safeParse(target)
    if (!h.isSettings(event.sender) || !parsed.success) return Promise.resolve(false)
    return h.reveal(parsed.data)
  })

  ipcMain.handle(SETTINGS_IPC.updateAi, (event, patch: unknown): Promise<UpdateResult> => {
    const parsed = aiPatchSchema.safeParse(patch)
    if (!h.isSettings(event.sender) || !parsed.success) {
      return Promise.resolve({ ok: false, message: 'That AI setting is not valid.' })
    }
    return h.updateAi(parsed.data)
  })

  ipcMain.handle(SETTINGS_IPC.testAi, (event, provider: unknown): Promise<ConnectionTest> => {
    const parsed = providerSchema.safeParse(provider)
    if (!h.isSettings(event.sender) || !parsed.success) {
      return Promise.resolve({ ok: false, kind: 'other', message: 'Unknown provider.' })
    }
    return h.testAi(parsed.data)
  })

  ipcMain.handle(SETTINGS_IPC.saveGeminiKey, (event, key: unknown): Promise<UpdateResult> => {
    const parsed = geminiKeySchema.safeParse(key)
    if (!h.isSettings(event.sender)) return Promise.resolve({ ok: false, message: 'Not allowed.' })
    if (!parsed.success) {
      return Promise.resolve({ ok: false, message: "That doesn't look like an API key." })
    }
    return h.saveGeminiKey(parsed.data)
  })

  ipcMain.handle(SETTINGS_IPC.removeGeminiKey, (event): Promise<UpdateResult> => {
    if (!h.isSettings(event.sender)) return Promise.resolve({ ok: false, message: 'Not allowed.' })
    return h.removeGeminiKey()
  })

  ipcMain.handle(SETTINGS_IPC.startOllama, (event): Promise<UpdateResult> => {
    if (!h.isSettings(event.sender)) return Promise.resolve({ ok: false, message: 'Not allowed.' })
    return h.startOllama()
  })

  ipcMain.handle(SETTINGS_IPC.deleteHistory, (event): Promise<UpdateResult> => {
    if (!h.isSettings(event.sender)) return Promise.resolve({ ok: false, message: 'Not allowed.' })
    return h.deleteHistory()
  })
}
