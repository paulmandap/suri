// Staying out of the way of full-screen games and apps (ADR-029). On
// 2026-10-07 a card popped up over Dota 2 and caught a click meant for the
// game (ADR-028). Windows tells main which window is in front and how big it
// is (src/main/foreground.ts); this decides from that alone whether Suri
// hides and stays silent. Pure, so the whole table is tested without Windows.

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** What Windows says about the window in front, in physical pixels. */
export interface ForegroundInfo {
  /** SHQueryUserNotificationState's answer (see QUNS), or null when the call failed. */
  notificationState: number | null
  /** The window in front, or null when there is none (a locked or headless desktop). */
  window: {
    rect: Rect
    /** The whole monitor the window is on, taskbar included. */
    monitor: Rect
    /** That monitor is the primary one, where the island sits (overlay.ts). */
    primary: boolean
    /** Maximized with a title bar: an ordinary window, even when it overhangs the monitor. */
    maximizedWithTitleBar: boolean
    className: string
    /** The program's file name in lower case, e.g. `dota2.exe`; '' when Windows won't say. */
    exe: string
  } | null
}

/** QUERY_USER_NOTIFICATION_STATE in shellapi.h. */
export const QUNS = {
  notPresent: 1,
  busy: 2,
  d3dFullScreen: 3,
  presentationMode: 4,
  acceptsNotifications: 5,
  quietTime: 6,
  app: 7
} as const

/** `exclusive`: a Direct3D game that owns the screen. `full-screen`: a window that fills it. */
export type QuietReason = 'exclusive' | 'presentation' | 'full-screen'

/** The desktop and the taskbar fill the monitor too, but nobody plays them. */
const DESKTOP_CLASSES: ReadonlySet<string> = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd'
])

/**
 * Where Claude Code runs. Full screen there is Paul at work, and that's
 * exactly when the approval card should show.
 */
export const CLAUDE_CODE_HOSTS: ReadonlySet<string> = new Set([
  'code.exe',
  'code - insiders.exe',
  'cursor.exe',
  'windsurf.exe',
  'windowsterminal.exe',
  'openconsole.exe',
  'conhost.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'mintty.exe',
  'wezterm-gui.exe',
  'alacritty.exe',
  'claude.exe'
])

/**
 * Why Suri should stay quiet right now, or null when it may show itself.
 * Quiet when a Direct3D game owns the screen, in presentation mode, or when
 * the window in front fills the island's monitor, unless it's the desktop or
 * a program Claude Code runs in.
 */
export function quietReason(info: ForegroundInfo | null): QuietReason | null {
  if (!info) return null
  if (info.notificationState === QUNS.d3dFullScreen) return 'exclusive'
  if (info.notificationState === QUNS.presentationMode) return 'presentation'
  const win = info.window
  if (!win || !win.primary || win.maximizedWithTitleBar) return null
  if (DESKTOP_CLASSES.has(win.className) || CLAUDE_CODE_HOSTS.has(win.exe)) return null
  return fillsMonitor(win.rect, win.monitor) ? 'full-screen' : null
}

/** The window reaches every edge of the monitor (games often overhang by a pixel or two). */
export function fillsMonitor(win: Rect, monitor: Rect): boolean {
  if (monitor.right <= monitor.left || monitor.bottom <= monitor.top) return false
  return (
    win.left <= monitor.left &&
    win.top <= monitor.top &&
    win.right >= monitor.right &&
    win.bottom >= monitor.bottom
  )
}

/** A line for the log and the tray: what's in front and why that means quiet. */
export function quietLabel(reason: QuietReason, exe: string): string {
  const who = exe || 'an app'
  if (reason === 'exclusive') return `${who} is a full-screen game`
  if (reason === 'presentation') return 'Windows is in presentation mode'
  return `${who} is full screen`
}
