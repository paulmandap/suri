import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { HISTORY_IPC, type DayView, type DaysView, type SaveResult } from '@shared/history-ipc'
import { daySchema, turnIdSchema } from '@shared/history-schemas'
import iconPath from '../../resources/icon.png?asset'

const BACKGROUND = '#0b0b0e'

/**
 * The History window (ADR-022): an ordinary window that can take focus, with
 * the same lockdown as Settings (sandbox, context isolation, no Node, its own
 * small preload). It reads history and asks main to write digests and recaps.
 */
export function createHistoryWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 700,
    minWidth: 700,
    minHeight: 480,
    title: 'Suri History',
    show: false,
    backgroundColor: BACKGROUND,
    icon: iconPath,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BACKGROUND, symbolColor: '#a1a1aa', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/history.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.removeMenu()

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.reload()
  })
  win.once('ready-to-show', () => win.show())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/history.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/history.html'))
  }
  if (process.env['SURI_DEVTOOLS'] === '1') win.webContents.openDevTools({ mode: 'detach' })
  return win
}

export interface HistoryHandlers {
  /** Only the History window may use these channels. */
  isHistory(sender: WebContents): boolean
  days(): DaysView
  day(day: string): DayView | null
  writeDigest(day: string): Promise<boolean>
  copyDigest(day: string): boolean
  saveDigest(day: string): Promise<SaveResult>
  writeRecap(turnId: number): boolean
}

/** Main checks who sent each message and what is in it; the page is never trusted. */
export function registerHistoryIpc(h: HistoryHandlers): void {
  ipcMain.handle(HISTORY_IPC.getDays, (event) => (h.isHistory(event.sender) ? h.days() : null))

  ipcMain.handle(HISTORY_IPC.getDay, (event, day: unknown) => {
    const parsed = daySchema.safeParse(day)
    return h.isHistory(event.sender) && parsed.success ? h.day(parsed.data) : null
  })

  ipcMain.handle(HISTORY_IPC.writeDigest, (event, day: unknown): Promise<boolean> => {
    const parsed = daySchema.safeParse(day)
    if (!h.isHistory(event.sender) || !parsed.success) return Promise.resolve(false)
    return h.writeDigest(parsed.data)
  })

  ipcMain.handle(HISTORY_IPC.copyDigest, (event, day: unknown): boolean => {
    const parsed = daySchema.safeParse(day)
    return h.isHistory(event.sender) && parsed.success ? h.copyDigest(parsed.data) : false
  })

  ipcMain.handle(HISTORY_IPC.saveDigest, (event, day: unknown): Promise<SaveResult> => {
    const parsed = daySchema.safeParse(day)
    if (!h.isHistory(event.sender) || !parsed.success) {
      return Promise.resolve({ ok: false, message: 'Not allowed.' })
    }
    return h.saveDigest(parsed.data)
  })

  ipcMain.handle(HISTORY_IPC.writeRecap, (event, turnId: unknown): boolean => {
    const parsed = turnIdSchema.safeParse(turnId)
    return h.isHistory(event.sender) && parsed.success ? h.writeRecap(parsed.data) : false
  })
}
