import { app, clipboard, dialog, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { electronApp } from '@electron-toolkit/utils'
import { KEEP_WARM_FOR, applyAiPatch, warmModel, type ProviderId } from '@shared/ai-config'
import { buildDigestFacts, digestMarkdown } from '@shared/digest'
import { MAX_FILE_BYTES, TEXT_EXTENSIONS, type AskStart, type LoadResult } from '@shared/file-qa'
import {
  askIdSchema,
  copyTextSchema,
  fileBytesSchema,
  fileNameSchema,
  questionSchema
} from '@shared/file-qa-schemas'
import { dayKey } from '@shared/history'
import { HISTORY_IPC, type DaysView, type SaveResult } from '@shared/history-ipc'
import { hookUrl } from '@shared/hook-config'
import { IPC } from '@shared/ipc'
import { assessRisk } from '@shared/risk-rules'
import { SETTINGS_IPC, type SettingsView, type UpdateResult } from '@shared/settings-ipc'
import type { GeneralPatch } from '@shared/settings-schemas'
import type { ApprovalDecision, IslandSnapshot, SuriSettings } from '@shared/types'
import { writeDigest } from './ai/digest'
import { createFileChat } from './ai/file-qa'
import { createGeminiProvider } from './ai/gemini'
import { createOllamaProvider } from './ai/ollama'
import type { AIProvider } from './ai/provider'
import { createRecapWriter } from './ai/recap'
import { createRiskExplainer } from './ai/risk'
import { createAIRouter } from './ai/router'
import { createModelWarmer } from './ai/warm'
import { createApprovalBroker, safetyNetAnswer } from './approvals'
import { historyFile, openHistory } from './history'
import { createHistoryWindow, registerHistoryIpc } from './history-window'
import { createHookServer, type HookHandlerOptions, type HookServer } from './hook-server'
import { claudeSettingsFile, createInstaller } from './installer'
import { ensureOllama, findOllamaApp, type OllamaStart } from './ollama-app'
import { openProjectFolder } from './open-project'
import {
  applyContentProtection,
  createOverlayWindow,
  setOverlayAsking,
  setOverlayInteractive
} from './overlay'
import { createSessionsStore } from './sessions-store'
import { createSecretStore } from './secrets'
import { loadSettings, updateSettings } from './settings'
import { createSettingsWindow, registerSettingsIpc } from './settings-window'
import { createTray, type SuriTray } from './tray'

// One fixed folder for dev and installed builds, so scripts/sandbox-hooks.mjs
// can find settings.json. SURI_DATA_DIR points a test run at a scratch folder
// instead (its own settings, history and single-instance lock). Must run
// before the app is ready.
const dataDir = process.env['SURI_DATA_DIR']
app.setPath('userData', dataDir ? resolve(dataDir) : join(app.getPath('appData'), 'Suri'))

const log = (line: string): void => console.warn(`[suri] ${line}`)
const DAY_MS = 24 * 60 * 60_000

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
  let historyWindow: BrowserWindow | null = null
  let tray: SuriTray | null = null
  // Looked up once: Settings only needs to know whether a Start button can work.
  const ollamaApp = findOllamaApp()

  // The Gemini key, encrypted with Windows DPAPI. Only main ever reads it (ADR-015).
  const secrets = createSecretStore(userData, {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data)
  })
  // keep_alive: while "keep warm" is on, Ollama holds the model 15 min after each call.
  const ollama = createOllamaProvider({
    url: () => settings.ai.ollamaUrl,
    keepAlive: () => (settings.ai.keepWarm ? KEEP_WARM_FOR : undefined)
  })
  const providers: Record<ProviderId, AIProvider> = {
    ollama,
    gemini: createGeminiProvider({ apiKey: () => secrets.get('geminiApiKey') })
  }
  // Loads the local model when Claude Code starts working, so the first risk
  // check or recap doesn't wait for it (ADR-024).
  const warmer = createModelWarmer({
    warm: (model, signal) => ollama.warm(model, signal),
    model: () => warmModel(settings.ai),
    log
  })
  const startOllama = (): Promise<OllamaStart> =>
    ensureOllama({
      reachable: async () => (await ollama.test()).ok,
      find: () => findOllamaApp(),
      launch: async (app) => (await shell.openPath(app)) || null
    })
  // Every AI feature asks the router: it picks the model from Settings and
  // takes these exact values (and pattern-matched secrets) out of cloud prompts.
  const router = createAIRouter({
    settings: () => settings.ai,
    providers,
    secrets: () => [settings.token, secrets.get('geminiApiKey') ?? '']
  })
  const riskExplainer = createRiskExplainer({ router, log })

  // The same values never reach the history either. Kept here rather than
  // decrypted on every event; a key saved or removed in Settings refreshes it.
  let storedSecrets: readonly string[] = [settings.token, secrets.get('geminiApiKey') ?? '']
  const refreshSecrets = (): void => {
    storedSecrets = [settings.token, secrets.get('geminiApiKey') ?? '']
  }
  // A history that can't open leaves Suri running without one (ADR-020).
  const opened = openHistory(userData, { secrets: () => storedSecrets, log })
  const history = opened.ok ? opened.history : null
  const historyProblem = opened.ok ? undefined : opened.message
  if (!opened.ok) log(`history is off: ${opened.message}`)

  const approvals = createApprovalBroker({
    onSettled: (approval, outcome) => {
      // Answered on the island: clear the wait now instead of on Claude Code's next event.
      if (outcome === 'allow' || outcome === 'deny') {
        sessions.answerPermission(approval.sessionId, outcome)
      }
      if (!approval.replayed) history?.recordDecision(approval, outcome)
    },
    explain: (input, signal) => riskExplainer.explain(input, signal)
  })

  // Recaps share the GPU with the risk check, and Paul waits on that one:
  // a recap waits while a check runs and stops if one starts (ADR-021).
  const recaps = history
    ? createRecapWriter({
        router,
        source: (turnId) => history.recapSource(turnId),
        save: (turnId, update) => history.setRecap(turnId, update),
        busy: () => approvals.list().some((approval) => approval.checkingRisk === true),
        log
      })
    : null
  approvals.onChange(() => recaps?.nudge())

  /** A turn just finished: write its recap, and show it on the finished card if it's still up. */
  const recapTurn = (sessionId: string, turnId: number): void => {
    if (!recaps || !settings.recaps) return
    const finishedAt = sessions.get(sessionId)?.finishedAt
    if (finishedAt === undefined) return recaps.queue(turnId)
    sessions.markRecap(sessionId, finishedAt, { writing: true })
    recaps.queue(turnId, (result) =>
      sessions.markRecap(
        sessionId,
        finishedAt,
        result.ok
          ? {
              recap: {
                title: result.recap.title,
                summary: result.recap.summary,
                outcome: result.recap.outcome
              }
            }
          : { failed: true }
      )
    )
  }

  const serverOptions = (port: number): HookHandlerOptions => ({
    port,
    token: settings.token,
    isPaused: () => settings.paused,
    onEvent: (event, { signal }) => {
      warmer.touch()
      sessions.apply(event)
      const turn = history?.record(event) ?? null
      if (event.hook_event_name === 'Stop' && turn !== null) recapTurn(event.session_id, turn)
      if (event.hook_event_name === 'PreToolUse' && settings.safetyNet) {
        // The safety net (ADR-007): high-risk commands must be asked about,
        // even when Paul's settings would let them run straight away.
        const risk = assessRisk(event.tool_name, event.tool_input, event.cwd)
        if (risk?.level === 'high') return safetyNetAnswer(risk)
      }
      if (event.hook_event_name === 'PermissionRequest') return approvals.request(event, signal)
      return null
    },
    log
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
        soundFinished: settings.soundFinished,
        recaps: settings.recaps,
        history: {
          file: historyFile(userData),
          ok: history !== null,
          ...(historyProblem ? { message: historyProblem } : {})
        }
      },
      server: server.status(),
      hooks: { file, exists, url: hookUrl(settings.port), inspection, lastBackup },
      ai: {
        settings: settings.ai,
        geminiKey: secrets.has('geminiApiKey') ? 'saved' : 'missing',
        secureStorage: secrets.available(),
        ollamaApp: ollamaApp !== null
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

  let islandReady = false
  let askWaiting = false
  ipcMain.on(IPC.rendererReady, (event) => {
    if (!fromOverlay(event.sender)) return
    event.sender.send(IPC.snapshot, snapshot())
    islandReady = true
    if (askWaiting) {
      askWaiting = false
      event.sender.send(IPC.openAsk)
    }
  })
  // Questions about a file (ADR-027). The page sends bytes or asks main to
  // show an Open dialog; it never names a path. The file stays in memory.
  let askOpen = false
  ipcMain.on(IPC.setInteractive, (event, interactive: unknown) => {
    // While the file panel is open the window keeps taking clicks.
    if (overlay && fromOverlay(event.sender) && typeof interactive === 'boolean' && !askOpen) {
      setOverlayInteractive(overlay, interactive)
    }
  })
  const fileChat = createFileChat({
    router,
    route: () => settings.ai.routes.fileQa,
    emit: (event) => {
      if (overlay && !overlay.isDestroyed()) overlay.webContents.send(IPC.askEvent, event)
    },
    log
  })
  ipcMain.on(IPC.setAskOpen, (event, open: unknown) => {
    if (!overlay || !fromOverlay(event.sender) || typeof open !== 'boolean') return
    askOpen = open
    setOverlayAsking(overlay, open)
    if (!open) fileChat.close()
  })
  ipcMain.handle(IPC.loadFile, (event, name: unknown, bytes: unknown): Promise<LoadResult> => {
    const parsedName = fileNameSchema.safeParse(name)
    const parsedBytes = fileBytesSchema.safeParse(bytes)
    if (!fromOverlay(event.sender) || !askOpen) {
      return Promise.resolve({ ok: false, message: 'Open the file panel first.' })
    }
    if (!parsedName.success || !parsedBytes.success) {
      const issue = parsedBytes.success ? undefined : parsedBytes.error.issues[0]?.message
      return Promise.resolve({ ok: false, message: issue ?? "That file can't be read." })
    }
    return fileChat.load(parsedName.data, parsedBytes.data)
  })
  ipcMain.handle(IPC.chooseFile, async (event): Promise<LoadResult> => {
    if (!overlay || !fromOverlay(event.sender) || !askOpen) {
      return { ok: false, message: 'Not allowed.' }
    }
    // Owned by the island, so it opens above it: the island stays on top of
    // every other window, and both sit near the top of the screen.
    const chosen = await dialog.showOpenDialog(overlay, {
      title: 'Ask Suri about a file',
      properties: ['openFile'],
      filters: [
        { name: 'PDF, text and code', extensions: ['pdf', ...TEXT_EXTENSIONS] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const path = chosen.filePaths[0]
    if (chosen.canceled || !path) return { ok: false, message: '' }
    try {
      const size = (await stat(path)).size
      if (size > MAX_FILE_BYTES) {
        return { ok: false, message: 'Suri reads files up to 20 MB.' }
      }
      return fileChat.load(basename(path), new Uint8Array(await readFile(path)))
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.ask, (event, question: unknown): AskStart => {
    const parsed = questionSchema.safeParse(question)
    if (!fromOverlay(event.sender) || !askOpen) return { ok: false, message: 'Not allowed.' }
    if (!parsed.success) return { ok: false, message: 'Ask a question of up to 2,000 characters.' }
    return fileChat.ask(parsed.data)
  })
  ipcMain.on(IPC.cancelAsk, (event, id: unknown) => {
    const parsed = askIdSchema.safeParse(id)
    if (fromOverlay(event.sender) && parsed.success) fileChat.cancel(parsed.data)
  })
  // The island can't use the page's clipboard: it isn't focused most of the time.
  ipcMain.handle(IPC.copyText, (event, text: unknown): boolean => {
    const parsed = copyTextSchema.safeParse(text)
    if (!fromOverlay(event.sender) || !parsed.success) return false
    clipboard.writeText(parsed.data)
    return true
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
    if (patch.recaps !== undefined) change({ recaps: patch.recaps })
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
      if (target === 'history-file') {
        const file = historyFile(userData)
        if (!existsSync(file)) return (await shell.openPath(userData)) === ''
        shell.showItemInFolder(file)
        return true
      }
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
      // Cached answers came from the old model, and the model to keep warm may differ.
      riskExplainer.clear()
      warmer.reset()
      return { ok: true }
    },
    deleteHistory: async () => {
      if (!history) return { ok: false, message: historyProblem ?? 'History is off.' }
      try {
        const turns = history.clear()
        log(`history deleted (${turns} turns)`)
        return { ok: true }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
    startOllama: async () => {
      const started = await startOllama()
      if (started.state === 'running' || started.state === 'started') return { ok: true }
      return {
        ok: false,
        message:
          started.state === 'not-installed'
            ? "Ollama isn't installed. Get it from ollama.com."
            : started.message
      }
    },
    testAi: (provider) => providers[provider].test(),
    saveGeminiKey: async (key) => {
      try {
        secrets.set('geminiApiKey', key)
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      refreshSecrets()
      push()
      return { ok: true }
    },
    removeGeminiKey: async () => {
      secrets.remove('geminiApiKey')
      refreshSecrets()
      push()
      return { ok: true }
    }
  })

  // History (ADR-022): a third window, reading the history and asking main for
  // digests and recaps. Main does the writing; the page never names a path.
  const digestsWriting = new Map<string, Promise<boolean>>()
  let historyPing: ReturnType<typeof setTimeout> | null = null
  const pingHistory = (): void => {
    if (historyPing) return
    historyPing = setTimeout(() => {
      historyPing = null
      if (historyWindow && !historyWindow.isDestroyed()) {
        historyWindow.webContents.send(HISTORY_IPC.changed)
      }
    }, 250)
  }
  history?.onChange(pingHistory)

  const writeDayDigest = (day: string): Promise<boolean> => {
    const running = digestsWriting.get(day)
    if (running) return running
    if (!history) return Promise.resolve(false)
    const job = (async (): Promise<boolean> => {
      const facts = buildDigestFacts(day, history.turns(day), history.decisions(day))
      history.saveDigest(await writeDigest({ router, facts, now: Date.now, log }))
      return true
    })()
      .catch((err: unknown) => {
        log(`digest not saved: ${err instanceof Error ? err.message : String(err)}`)
        return false
      })
      .finally(() => {
        digestsWriting.delete(day)
        pingHistory()
      })
    digestsWriting.set(day, job)
    pingHistory()
    return job
  }

  const openHistoryWindow = (day?: string): void => {
    if (historyWindow && !historyWindow.isDestroyed()) {
      if (historyWindow.isMinimized()) historyWindow.restore()
      historyWindow.show()
      historyWindow.focus()
      if (day) historyWindow.webContents.send(HISTORY_IPC.showDay, day)
      return
    }
    // A new window starts on today by itself.
    const win = createHistoryWindow()
    historyWindow = win
    win.on('closed', () => {
      if (historyWindow === win) historyWindow = null
    })
  }

  /** The tray's "Today's digest": History on today, with notes written if there are none. */
  const openDigest = (): void => {
    const today = dayKey(Date.now())
    openHistoryWindow(today)
    if (history && !history.digest(today) && history.turns(today).length > 0) {
      void writeDayDigest(today)
    }
  }

  registerHistoryIpc({
    isHistory: (sender) =>
      historyWindow !== null &&
      !historyWindow.isDestroyed() &&
      sender === historyWindow.webContents,
    days: (): DaysView => {
      const today = dayKey(Date.now())
      const days = history?.days() ?? []
      if (days[0]?.day !== today) days.unshift({ day: today, turns: 0, projects: 0 })
      return { today, days, ...(historyProblem ? { unavailable: historyProblem } : {}) }
    },
    day: (day) => {
      if (!history) return null
      const turns = history.turns(day)
      const digest = history.digest(day)
      const counted = buildDigestFacts(day, turns, []).turns
      return {
        day,
        turns,
        digest: {
          writing: digestsWriting.has(day),
          digest,
          newTurns: digest ? Math.max(0, counted - digest.turns) : 0
        }
      }
    },
    writeDigest: writeDayDigest,
    copyDigest: (day) => {
      const digest = history?.digest(day)
      if (!digest) return false
      clipboard.writeText(digestMarkdown(digest))
      return true
    },
    saveDigest: async (day): Promise<SaveResult> => {
      const digest = history?.digest(day)
      if (!digest) return { ok: false, message: 'Write the notes first.' }
      const options = {
        title: 'Save standup notes',
        defaultPath: join(app.getPath('documents'), `suri-digest-${day}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const win = historyWindow && !historyWindow.isDestroyed() ? historyWindow : null
      const chosen = await (win
        ? dialog.showSaveDialog(win, options)
        : dialog.showSaveDialog(options))
      if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true }
      try {
        writeFileSync(chosen.filePath, digestMarkdown(digest), 'utf8')
        return { ok: true, path: chosen.filePath }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
    writeRecap: (turnId) => {
      if (!recaps) return false
      recaps.queue(turnId)
      return true
    }
  })

  // `suri --ask` at launch comes before the island's page is ready: it waits.
  const openAsk = (): void => {
    if (!islandReady) askWaiting = true
    else if (overlay && !overlay.isDestroyed()) overlay.webContents.send(IPC.openAsk)
  }

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
      openAsk,
      openDigest,
      openHistory: () => openHistoryWindow(),
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

  // `suri --settings` opens Settings, `suri --history` History, `suri --digest`
  // today's standup notes and `suri --ask` the file panel, also when Suri is
  // already running (a shortcut or a hotkey can use them).
  const openFromArgs = (argv: readonly string[]): boolean => {
    if (argv.includes('--settings')) openSettings()
    else if (argv.includes('--history')) openHistoryWindow()
    else if (argv.includes('--digest')) openDigest()
    else if (argv.includes('--ask')) openAsk()
    else return false
    return true
  }
  app.on('second-instance', (_event, argv) => {
    if (!openFromArgs(argv)) openIsland()
  })
  app.on('before-quit', () => {
    recaps?.stop()
    approvals.releaseAll()
    installer.close()
    void server.stop()
    tray?.destroy()
  })
  app.on('quit', () => history?.close())

  const status = await server.start()
  if (status.state === 'error') log(`hook server: ${status.message}`)
  setInterval(() => sessions.prune(), 60_000).unref()
  // Paul's choice (ADR-024): a closed Ollama is started with Suri, so the
  // first risk check doesn't fail. It only starts the app; models load later.
  if (settings.ai.startOllama) {
    void startOllama().then((started) => {
      if (started.state === 'started') log('started Ollama')
      if (started.state === 'failed') log(started.message)
    })
  }
  if (history) {
    history.prune()
    setInterval(() => history.prune(), 6 * 60 * 60_000).unref()
    // Recaps still waiting when Suri last quit.
    if (settings.recaps) {
      for (const turnId of history.pendingRecaps(Date.now() - DAY_MS)) recaps?.queue(turnId)
    }
  }
  openFromArgs(process.argv)
}
