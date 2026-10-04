import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { electronApp } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import { assessRisk } from '@shared/risk-rules'
import type { ApprovalDecision, IslandSnapshot, SuriSettings } from '@shared/types'
import { createApprovalBroker, safetyNetAnswer } from './approvals'
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

const DECISIONS: readonly ApprovalDecision[] = ['allow', 'deny', 'ask']

async function start(): Promise<void> {
  electronApp.setAppUserModelId('io.github.paulmandap.suri')
  const userData = app.getPath('userData')
  let settings: SuriSettings = loadSettings(userData)
  const sessions = createSessionsStore()
  let overlay: BrowserWindow | null = null
  let tray: SuriTray | null = null

  const approvals = createApprovalBroker({
    // Answered on the island: clear the wait now instead of on Claude Code's next event.
    onSettled: (approval, outcome) => {
      if (outcome === 'allow' || outcome === 'deny') {
        sessions.answerPermission(approval.sessionId, outcome)
      }
    }
  })

  const server = createHookServer({
    port: settings.port,
    token: settings.token,
    isPaused: () => settings.paused,
    onEvent: (event, { signal }) => {
      sessions.apply(event)
      if (event.hook_event_name === 'PreToolUse' && settings.safetyNet) {
        // The safety net (ADR-007): high-risk commands must be asked about,
        // even when Paul's settings would let them run straight away.
        const risk = assessRisk(event.tool_name, event.tool_input)
        if (risk?.level === 'high') return safetyNetAnswer(risk)
      }
      if (event.hook_event_name === 'PermissionRequest') return approvals.request(event, signal)
      return null
    },
    log: (line) => console.warn(`[suri] ${line}`)
  })

  const snapshot = (): IslandSnapshot => ({
    sessions: sessions.list(),
    approvals: approvals.list(),
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
  approvals.onChange(push)
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
  // Only a click on the island can answer: the renderer sends an id and a decision.
  ipcMain.handle(IPC.decideApproval, (event, approvalId: unknown, decision: unknown) => {
    if (!fromOverlay(event.sender) || typeof approvalId !== 'string') return false
    if (!DECISIONS.includes(decision as ApprovalDecision)) return false
    return approvals.decide(approvalId, decision as ApprovalDecision)
  })

  const openIsland = (): void => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send(IPC.openIsland)
  }

  const change = (patch: Partial<Omit<SuriSettings, 'token'>>): void => {
    settings = updateSettings(userData, settings, patch)
    push()
  }

  tray = createTray(
    () => ({
      sessions: sessions.list().length,
      paused: settings.paused,
      hideFromCapture: settings.hideFromCapture,
      safetyNet: settings.safetyNet,
      hookServer: server.status()
    }),
    {
      open: openIsland,
      togglePause: () => {
        change({ paused: !settings.paused })
        // Paused means Suri isn't there: step aside on anything it's holding.
        if (settings.paused) approvals.releaseAll()
      },
      toggleHideFromCapture: () => {
        change({ hideFromCapture: !settings.hideFromCapture })
        if (overlay && !overlay.isDestroyed()) {
          applyContentProtection(overlay, settings.hideFromCapture)
        }
      },
      toggleSafetyNet: () => change({ safetyNet: !settings.safetyNet }),
      quit: () => app.quit()
    }
  )

  app.on('second-instance', openIsland)
  app.on('before-quit', () => {
    approvals.releaseAll()
    void server.stop()
    tray?.destroy()
  })

  const status = await server.start()
  if (status.state === 'error') console.warn(`[suri] hook server: ${status.message}`)
  setInterval(() => sessions.prune(), 60_000).unref()
}
