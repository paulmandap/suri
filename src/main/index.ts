import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { electronApp } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import type { IslandSnapshot, SuriSettings } from '@shared/types'
import { createHookServer } from './hook-server'
import { openProjectFolder } from './open-project'
import { applyContentProtection, createOverlayWindow, setOverlayInteractive } from './overlay'
import { createSessionsStore } from './sessions-store'
import { loadSettings, updateSettings } from './settings'
import { createTray, type SuriTray } from './tray'

// One fixed folder for dev and installed builds, so scripts/sandbox-hooks.mjs
// can find settings.json. Must run before the app is ready.
app.setPath('userData', join(app.getPath('appData'), 'Suri'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app
    .whenReady()
    .then(start)
    .catch((err) => {
      console.error('[suri] failed to start', err)
      app.quit()
    })
}

// A tray app: closing windows never quits; only "Quit Suri" does.
app.on('window-all-closed', () => {})

async function start(): Promise<void> {
  electronApp.setAppUserModelId('io.github.paulmandap.suri')
  const userData = app.getPath('userData')
  let settings: SuriSettings = loadSettings(userData)
  const sessions = createSessionsStore()
  let overlay: BrowserWindow | null = null
  let tray: SuriTray | null = null

  const server = createHookServer({
    port: settings.port,
    token: settings.token,
    isPaused: () => settings.paused,
    onEvent: (event) => {
      sessions.apply(event)
      // Phase 1 only watches. Approvals (an answer to PermissionRequest) arrive in Phase 2.
      return null
    },
    log: (line) => console.warn(`[suri] ${line}`)
  })

  const snapshot = (): IslandSnapshot => ({
    sessions: sessions.list(),
    paused: settings.paused,
    hookServer: server.status(),
    sentAt: Date.now()
  })

  // Coalesce bursts (a tool call is two events) into one push every 50 ms.
  let scheduled: ReturnType<typeof setTimeout> | null = null
  const push = (): void => {
    if (scheduled) return
    scheduled = setTimeout(() => {
      scheduled = null
      if (overlay && !overlay.isDestroyed()) overlay.webContents.send(IPC.snapshot, snapshot())
      tray?.refresh()
    }, 50)
  }
  sessions.onChange(push)
  server.onStatus(push)

  overlay = createOverlayWindow({ hideFromCapture: settings.hideFromCapture })
  const fromOverlay = (sender: Electron.WebContents): boolean =>
    overlay !== null && !overlay.isDestroyed() && sender === overlay.webContents

  ipcMain.on(IPC.rendererReady, (event) => {
    if (fromOverlay(event.sender)) event.sender.send(IPC.snapshot, snapshot())
  })
  ipcMain.on(IPC.setInteractive, (event, interactive: unknown) => {
    if (overlay && fromOverlay(event.sender) && typeof interactive === 'boolean') {
      setOverlayInteractive(overlay, interactive)
    }
  })
  // The renderer names a session; main looks up its folder. A path from the
  // renderer is never trusted.
  ipcMain.handle(IPC.openSession, async (event, sessionId: unknown) => {
    if (!fromOverlay(event.sender) || typeof sessionId !== 'string') return false
    const session = sessions.get(sessionId)
    return session ? openProjectFolder(session.cwd) : false
  })

  const openIsland = (): void => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send(IPC.openIsland)
  }

  tray = createTray(
    () => ({
      sessions: sessions.list().length,
      paused: settings.paused,
      hideFromCapture: settings.hideFromCapture,
      hookServer: server.status()
    }),
    {
      open: openIsland,
      togglePause: () => {
        settings = updateSettings(userData, settings, { paused: !settings.paused })
        push()
      },
      toggleHideFromCapture: () => {
        settings = updateSettings(userData, settings, {
          hideFromCapture: !settings.hideFromCapture
        })
        if (overlay && !overlay.isDestroyed())
          applyContentProtection(overlay, settings.hideFromCapture)
        push()
      },
      quit: () => app.quit()
    }
  )

  app.on('second-instance', openIsland)
  app.on('before-quit', () => {
    void server.stop()
    tray?.destroy()
  })

  const status = await server.start()
  if (status.state === 'error') console.warn(`[suri] hook server: ${status.message}`)
  setInterval(() => sessions.prune(), 60_000).unref()
}
