import { BrowserWindow, app, ipcMain } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { ApplyHooksResult, PreviewResult } from '@shared/settings-ipc'
import { previewIdSchema } from '@shared/settings-schemas'
import { UNINSTALL_IPC, type FinishResult, type UninstallView } from '@shared/uninstall-ipc'
import { APP_ID } from './app-id'
import { claudeSettingsFile, createInstaller } from './installer'
import { deleteSuriData, hasSuriData, savedHookTarget } from './suri-data'
import iconPath from '../../resources/icon.png?asset'

// `suri --uninstall` (ADR-031). The Windows uninstaller runs it before it
// deletes the app (build/installer.nsh) and waits for it to quit. Paul then
// decides about Claude Code's hooks (the same preview, backup and click as
// Settings, ADR-013) and about Suri's data.

export const UNINSTALL_FLAG = '--uninstall'

const BACKGROUND = '#0b0b0e'

/**
 * Shows the Uninstall window and quits when it closes. `dataDir` is Suri's
 * folder; Electron's own files for this run go somewhere else (index.ts), so
 * nothing in it is in use.
 */
export async function runUninstall(opts: {
  dataDir: string
  defaultDir: string
  log: (line: string) => void
}): Promise<void> {
  const target = savedHookTarget(opts.dataDir)
  const installer = createInstaller({ file: claudeSettingsFile(), target: () => target })
  await installer.refresh()

  // A leftover "Start with Windows" entry would point at a deleted app. Its
  // name comes from the app id, which the normal start sets (index.ts).
  app.setAppUserModelId(APP_ID)
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: false })

  const win = createUninstallWindow()
  const fromWindow = (sender: Electron.WebContents): boolean =>
    !win.isDestroyed() && sender === win.webContents
  win.on('closed', () => app.quit())

  ipcMain.handle(UNINSTALL_IPC.getView, async (event): Promise<UninstallView | null> => {
    if (!fromWindow(event.sender)) return null
    await installer.refresh()
    const { file, exists, inspection } = installer.status()
    return {
      hooks: { file, exists, inspection },
      data: { folder: opts.dataDir, exists: hasSuriData(opts.dataDir) }
    }
  })
  ipcMain.handle(UNINSTALL_IPC.previewRemoval, (event): Promise<PreviewResult> => {
    if (!fromWindow(event.sender)) return Promise.resolve({ ok: false, message: 'Not allowed.' })
    return installer.preview('uninstall')
  })
  ipcMain.handle(UNINSTALL_IPC.applyRemoval, (event, id: unknown): Promise<ApplyHooksResult> => {
    const parsed = previewIdSchema.safeParse(id)
    if (!fromWindow(event.sender) || !parsed.success) {
      return Promise.resolve({ ok: false, reason: 'stale', message: 'That preview is not valid.' })
    }
    return installer.apply(parsed.data)
  })
  ipcMain.handle(UNINSTALL_IPC.finish, (event, deleteData: unknown): FinishResult => {
    if (!fromWindow(event.sender)) return { ok: false, message: 'Not allowed.' }
    if (deleteData === true) {
      const deleted = deleteSuriData(opts.dataDir, opts.defaultDir)
      if (!deleted.ok) return deleted
      opts.log("deleted Suri's data")
    }
    // Close once this answer is on its way; quitting follows the window.
    setTimeout(() => win.close(), 0)
    return { ok: true }
  })
}

function createUninstallWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 680,
    height: 640,
    minWidth: 560,
    minHeight: 480,
    title: 'Uninstall Suri',
    show: false,
    backgroundColor: BACKGROUND,
    icon: iconPath,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BACKGROUND, symbolColor: '#a1a1aa', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/uninstall.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.removeMenu()
  // It only ever shows its own page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/uninstall.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/uninstall.html'))
  }
  if (process.env['SURI_DEVTOOLS'] === '1') win.webContents.openDevTools({ mode: 'detach' })
  return win
}
