import { app, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import { electronApp } from '@electron-toolkit/utils'
import { applyAiPatch, type ProviderId } from '@shared/ai-config'
import { hookUrl } from '@shared/hook-config'
import { IPC } from '@shared/ipc'
import { assessRisk } from '@shared/risk-rules'
import { SETTINGS_IPC, type SettingsView, type UpdateResult } from '@shared/settings-ipc'
import type { GeneralPatch } from '@shared/settings-schemas'
import type { ApprovalDecision, IslandSnapshot, SuriSettings } from '@shared/types'
import { createGeminiProvider } from './ai/gemini'
import { createOllamaProvider } from './ai/ollama'
import type { AIProvider } from './ai/provider'
import { createRiskExplainer } from './ai/risk'
import { createAIRouter } from './ai/router'
import { createApprovalBroker, safetyNetAnswer } from './approvals'
import { createHookServer, type HookHandlerOptions, type HookServer } from './hook-server'
import { claudeSettingsFile, createInstaller } from './installer'
import { openProjectFolder } from './open-project'
import { applyContentProtection, createOverlayWindow, setOverlayInteractive } from './overlay'
import { createSessionsStore } from './sessions-store'
import { createSecretStore } from './secrets'
import { loadSettings, updateSettings } from './settings'
import { createSettingsWindow, registerSettingsIpc } from './settings-window'
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
  let settingsWindow: BrowserWindow | null = null
  let tray: SuriTray | null = null

  // The Gemini key, encrypted with Windows DPAPI. Only main ever reads it (ADR-015).
  const secrets = createSecretStore(userData, {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data)
  })
  const providers: Record<ProviderId, AIProvider> = {
    ollama: createOllamaProvider({ url: () => settings.ai.ollamaUrl }),
    gemini: createGeminiProvider({ apiKey: () => secrets.get('geminiApiKey') })
  }
  // Every AI feature asks the router: it picks the model from Settings and
  // takes these exact values (and pattern-matched secrets) out of cloud prompts.
  const router = createAIRouter({
    settings: () => settings.ai,
    providers,
    secrets: () => [settings.token, secrets.get('geminiApiKey') ?? '']
  })
  const riskExplainer = createRiskExplainer({
    router,
    log: (line) => console.warn(`[suri] ${line}`)
  })

  const approvals = createApprovalBroker({
    // Answered on the island: clear the wait now instead of on Claude Code's next event.
    onSettled: (approval, outcome) => {
      if (outcome === 'allow' || outcome === 'deny') {
        sessions.answerPermission(approval.sessionId, outcome)
      }
    },
    explain: (input, signal) => riskExplainer.explain(input, signal)
  })

  const serverOptions = (port: number): HookHandlerOptions => ({
    port,
    token: settings.token,
    isPaused: () => settings.paused,
    onEvent: (event, { signal }) => {
      sessions.apply(event)
      if (event.hook_event_name === 'PreToolUse' && settings.safetyNet) {
        // The safety net (ADR-007): high-risk commands must be asked about,
        // even when Paul's settings would let them run straight away.
        const risk = assessRisk(event.tool_name, event.tool_input, event.cwd)
        if (risk?.level === 'high') return safetyNetAnswer(risk)
      }
      if (event.hook_event_name === 'PermissionRequest') return approvals.request(event, signal)
      return null
    },
    log: (line) => console.warn(`[suri] ${line}`)
  })
  let server: HookServer = createHookServer(serverOptions(settings.port))

  // Suri's hooks in Claude Code's user settings. Written only from the
  // Settings window, after a preview and a click (ADR-013).
  const installer = createInstaller({
    file: claudeSettingsFile(),
    target: () => ({ port: settings.port, token: settings.token })
  })
  // Read it before any window asks, so the island never flashes "not installed".
  await installer.refresh()
  installer.watch()

  // A dev build would register electron.exe itself, so only the installed app may.
  let openAtLogin = app.isPackaged && app.getLoginItemSettings().openAtLogin

  const snapshot = (): IslandSnapshot => ({
    sessions: sessions.list(),
    approvals: approvals.list(),
    paused: settings.paused,
    hookServer: server.status(),
    hooks: installer.status().inspection.state,
    sounds: { needsYou: settings.soundNeedsYou, finished: settings.soundFinished },
    sentAt: Date.now()
  })

  const settingsView = (): SettingsView => {
    const { file, exists, inspection, lastBackup } = installer.status()
    return {
      general: {
        port: settings.port,
        hideFromCapture: settings.hideFromCapture,
        safetyNet: settings.safetyNet,
        openAtLogin,
        canOpenAtLogin: app.isPackaged,
        soundNeedsYou: settings.soundNeedsYou,
        soundFinished: settings.soundFinished
      },
      server: server.status(),
      hooks: { file, exists, url: hookUrl(settings.port), inspection, lastBackup },
      ai: {
        settings: settings.ai,
        geminiKey: secrets.has('geminiApiKey') ? 'saved' : 'missing',
        secureStorage: secrets.available()
      }
    }
  }

  // Coalesce bursts (a tool call is two events) into one push every 50 ms.
  let scheduled: ReturnType<typeof setTimeout> | null = null
  let lastView = ''
  const push = (): void => {
    if (scheduled) return
    scheduled = setTimeout(() => {
      scheduled = null
      if (overlay && !overlay.isDestroyed()) overlay.webContents.send(IPC.snapshot, snapshot())
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        // Session events don't change Settings; only send it a view that did change.
        const view = settingsView()
        const key = JSON.stringify(view)
        if (key !== lastView) settingsWindow.webContents.send(SETTINGS_IPC.view, view)
        lastView = key
      }
      tray?.refresh()
    }, 50)
  }
  sessions.onChange(push)
  approvals.onChange(push)
  installer.onChange(push)
  let unwatchServer = server.onStatus(push)

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

  const setHideFromCapture = (hide: boolean): void => {
    change({ hideFromCapture: hide })
    if (overlay && !overlay.isDestroyed()) applyContentProtection(overlay, hide)
  }

  const setOpenAtLogin = (open: boolean): void => {
    if (!app.isPackaged) return
    app.setLoginItemSettings({ openAtLogin: open })
    openAtLogin = app.getLoginItemSettings().openAtLogin
    push()
  }

  /**
   * Moves the hook server to another port. The new server starts before the
   * old one stops, so a taken port never leaves Suri deaf. Also retries the
   * same port after it failed at startup.
   */
  const changePort = async (port: number): Promise<UpdateResult> => {
    if (port === settings.port && server.status().state === 'listening') return { ok: true }
    const next = createHookServer(serverOptions(port))
    const status = await next.start()
    if (status.state !== 'listening') {
      return { ok: false, message: status.state === 'error' ? status.message : 'It did not start.' }
    }
    const previous = server
    unwatchServer()
    server = next
    unwatchServer = next.onStatus(push)
    // Requests held on the old port: step aside so Claude Code asks for itself.
    approvals.releaseAll()
    await previous.stop()
    change({ port })
    // The installed hooks still name the old port; Settings now offers the update.
    await installer.refresh()
    return { ok: true }
  }

  const updateGeneral = async (patch: GeneralPatch): Promise<UpdateResult> => {
    if (patch.hideFromCapture !== undefined) setHideFromCapture(patch.hideFromCapture)
    if (patch.safetyNet !== undefined) change({ safetyNet: patch.safetyNet })
    if (patch.soundNeedsYou !== undefined) change({ soundNeedsYou: patch.soundNeedsYou })
    if (patch.soundFinished !== undefined) change({ soundFinished: patch.soundFinished })
    if (patch.openAtLogin !== undefined) setOpenAtLogin(patch.openAtLogin)
    if (patch.port !== undefined) return changePort(patch.port)
    return { ok: true }
  }

  const openSettings = (): void => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMinimized()) settingsWindow.restore()
      settingsWindow.show()
      settingsWindow.focus()
      return
    }
    const win = createSettingsWindow()
    settingsWindow = win
    lastView = ''
    // Catch edits made while Settings was in the background.
    win.on('focus', () => void installer.refresh())
    win.on('closed', () => {
      if (settingsWindow === win) settingsWindow = null
    })
  }

  registerSettingsIpc({
    isSettings: (sender) =>
      settingsWindow !== null &&
      !settingsWindow.isDestroyed() &&
      sender === settingsWindow.webContents,
    view: () => {
      const view = settingsView()
      lastView = JSON.stringify(view)
      return view
    },
    updateGeneral,
    previewHooks: (action) => installer.preview(action),
    applyHooks: (previewId) => installer.apply(previewId),
    // Main picks the path; the page only says which one.
    reveal: async (target) => {
      const { file, exists, lastBackup } = installer.status()
      if (target === 'last-backup') {
        if (!lastBackup) return false
        shell.showItemInFolder(lastBackup)
        return true
      }
      if (exists) {
        shell.showItemInFolder(file)
        return true
      }
      return (await shell.openPath(dirname(file))) === ''
    },
    updateAi: async (patch) => {
      change({ ai: applyAiPatch(settings.ai, patch) })
      // Cached answers came from the old model.
      riskExplainer.clear()
      return { ok: true }
    },
    testAi: (provider) => providers[provider].test(),
    saveGeminiKey: async (key) => {
      try {
        secrets.set('geminiApiKey', key)
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      push()
      return { ok: true }
    },
    removeGeminiKey: async () => {
      secrets.remove('geminiApiKey')
      push()
      return { ok: true }
    }
  })

  tray = createTray(
    () => ({
      sessions: sessions.list().length,
      paused: settings.paused,
      hideFromCapture: settings.hideFromCapture,
      safetyNet: settings.safetyNet,
      hookServer: server.status(),
      hooks: installer.status().inspection.state
    }),
    {
      open: openIsland,
      openSettings,
      togglePause: () => {
        change({ paused: !settings.paused })
        // Paused means Suri isn't there: step aside on anything it's holding.
        if (settings.paused) approvals.releaseAll()
      },
      toggleHideFromCapture: () => setHideFromCapture(!settings.hideFromCapture),
      toggleSafetyNet: () => change({ safetyNet: !settings.safetyNet }),
      quit: () => app.quit()
    }
  )

  // `suri --settings` opens Settings, also when Suri is already running (a shortcut can use it).
  const wantsSettings = (argv: readonly string[]): boolean => argv.includes('--settings')
  app.on('second-instance', (_event, argv) => (wantsSettings(argv) ? openSettings() : openIsland()))
  app.on('before-quit', () => {
    approvals.releaseAll()
    installer.close()
    void server.stop()
    tray?.destroy()
  })

  const status = await server.start()
  if (status.state === 'error') console.warn(`[suri] hook server: ${status.message}`)
  setInterval(() => sessions.prune(), 60_000).unref()
  if (wantsSettings(process.argv)) openSettings()
}
