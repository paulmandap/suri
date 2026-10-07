import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import type { HookServerStatus, HookState } from '@shared/types'
// Suri's head in seven sizes (scripts/mascot/build_mascot.py): Windows picks
// the one that fits the tray at the display's scaling, so it stays sharp.
import trayIcon from '../../resources/tray.ico?asset'

export interface TrayState {
  sessions: number
  paused: boolean
  hideFromCapture: boolean
  safetyNet: boolean
  hookServer: HookServerStatus
  hooks: HookState
}

export interface TrayActions {
  open(): void
  /** History on today, with the standup notes written if there are none yet. */
  openDigest(): void
  openHistory(): void
  openSettings(): void
  togglePause(): void
  toggleHideFromCapture(): void
  toggleSafetyNet(): void
  quit(): void
}

export interface SuriTray {
  refresh(): void
  destroy(): void
}

/** A shortcut to the fix when Claude Code's settings don't point at Suri. */
const HOOKS_ITEM: Partial<Record<HookState, string>> = {
  'not-installed': 'Install Claude Code hooks…',
  outdated: 'Update Claude Code hooks…',
  unreadable: 'Check Claude Code settings…'
}

export function createTray(getState: () => TrayState, actions: TrayActions): SuriTray {
  const tray = new Tray(trayIcon)
  let lastKey = ''

  const refresh = (): void => {
    const state = getState()
    // Rebuilding the menu on every snapshot is wasteful; only when it changes.
    const key = JSON.stringify(state)
    if (key === lastKey) return
    lastKey = key
    tray.setToolTip(`Suri — ${statusLine(state)}`)
    const fix = HOOKS_ITEM[state.hooks]
    const items: MenuItemConstructorOptions[] = [
      { label: statusLine(state), enabled: false },
      ...(fix ? [{ label: fix, click: actions.openSettings }] : []),
      { type: 'separator' },
      { label: 'Open', click: actions.open },
      { label: "Today's digest", click: actions.openDigest },
      { label: 'History…', click: actions.openHistory },
      { type: 'separator' },
      { label: 'Pause', type: 'checkbox', checked: state.paused, click: actions.togglePause },
      {
        label: 'Safety net (ask before risky commands)',
        type: 'checkbox',
        checked: state.safetyNet,
        click: actions.toggleSafetyNet
      },
      {
        label: 'Hide from screen sharing',
        type: 'checkbox',
        checked: state.hideFromCapture,
        click: actions.toggleHideFromCapture
      },
      { type: 'separator' },
      { label: 'Settings…', click: actions.openSettings },
      { label: 'Quit Suri', click: actions.quit }
    ]
    tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  tray.on('click', actions.open)
  refresh()
  return { refresh, destroy: () => tray.destroy() }
}

function statusLine(state: TrayState): string {
  if (state.hookServer.state === 'error') return state.hookServer.message
  if (state.paused) return 'Paused'
  if (state.sessions > 0) {
    return state.sessions === 1 ? '1 Claude Code session' : `${state.sessions} Claude Code sessions`
  }
  if (state.hooks === 'not-installed') return 'Claude Code hooks not installed'
  if (state.hooks === 'outdated') return 'Claude Code hooks need an update'
  if (state.hooks === 'unreadable') return "Can't read Claude Code settings"
  return 'Watching for Claude Code'
}
