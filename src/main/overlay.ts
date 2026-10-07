import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

// One fixed window; the island shape animates inside it (ADR-006). Resizing
// a transparent window on Windows flickers, so the window itself never moves.
export const OVERLAY_WIDTH = 640
export const OVERLAY_HEIGHT = 420

export function createOverlayWindow(opts: { hideFromCapture: boolean }): BrowserWindow {
  const win = new BrowserWindow({
    ...overlayBounds(),
    title: 'Suri',
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Clicking the island must never steal focus from the editor or terminal.
    focusable: false,
    // A tool window stays out of Alt+Tab.
    type: 'toolbar',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  setOverlayInteractive(win, false)
  applyContentProtection(win, opts.hideFromCapture)

  // Stay pinned to the top centre when monitors or scaling change.
  const reposition = (): void => {
    if (!win.isDestroyed()) win.setBounds(overlayBounds())
  }
  screen.on('display-metrics-changed', reposition)
  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
  win.on('closed', () => {
    screen.off('display-metrics-changed', reposition)
    screen.off('display-added', reposition)
    screen.off('display-removed', reposition)
  })

  // The island only ever shows its own page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.reload()
  })

  win.once('ready-to-show', () => win.showInactive())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  if (process.env['SURI_DEVTOOLS'] === '1') win.webContents.openDevTools({ mode: 'detach' })

  return win
}

/**
 * Clicks fall through to the apps below unless the pointer is over the
 * island. `forward` keeps mouse moves coming while ignored, so the renderer
 * can tell when the pointer arrives.
 */
export function setOverlayInteractive(win: BrowserWindow, interactive: boolean): void {
  if (interactive) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}

/**
 * The file panel (ADR-027). While it's open the window takes every click,
 * because a file dragged from Explorer can't land on a click-through window
 * (Coucou's Windows bug #126), and it may take focus so a question can be
 * typed. The panel fills nearly the whole window, so little is blocked. When
 * it closes, the island goes back to never taking focus.
 */
export function setOverlayAsking(win: BrowserWindow, asking: boolean): void {
  if (asking) {
    win.setFocusable(true)
    setOverlayInteractive(win, true)
    // `suri --ask` at launch can get here before the window has appeared.
    if (win.isVisible()) win.focus()
    else win.once('show', () => win.focus())
    return
  }
  // Hand focus back first, while the window still owns it.
  if (win.isFocused()) win.blur()
  win.setFocusable(false)
  setOverlayInteractive(win, false)
}

/**
 * Leaves the overlay out of screen capture and sharing (ADR-005).
 * SURI_ALLOW_CAPTURE=1 turns it off for screenshots and demo recordings.
 */
export function applyContentProtection(win: BrowserWindow, enabled: boolean): void {
  win.setContentProtection(enabled && process.env['SURI_ALLOW_CAPTURE'] !== '1')
}

function overlayBounds(): Rectangle {
  const { bounds } = screen.getPrimaryDisplay()
  return {
    x: Math.round(bounds.x + (bounds.width - OVERLAY_WIDTH) / 2),
    y: bounds.y,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT
  }
}
