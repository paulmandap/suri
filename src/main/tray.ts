import { Menu, Tray, nativeImage } from 'electron'
import type { HookServerStatus } from '@shared/types'
import iconPath from '../../resources/icon.png?asset'

export interface TrayState {
  sessions: number
  paused: boolean
  hideFromCapture: boolean
  hookServer: HookServerStatus
}

export interface TrayActions {
  open(): void
  togglePause(): void
  toggleHideFromCapture(): void
  quit(): void
}

export interface SuriTray {
  refresh(): void
  destroy(): void
}

export function createTray(getState: () => TrayState, actions: TrayActions): SuriTray {
  const tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }))
  let lastKey = ''

  const refresh = (): void => {
    const state = getState()
    // Rebuilding the menu on every snapshot is wasteful; only when it changes.
    const key = JSON.stringify(state)
    if (key === lastKey) return
    lastKey = key
    tray.setToolTip(`Suri — ${statusLine(state)}`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: statusLine(state), enabled: false },
        { type: 'separator' },
        { label: 'Open', click: actions.open },
        { label: 'Pause', type: 'checkbox', checked: state.paused, click: actions.togglePause },
        {
          label: 'Hide from screen sharing',
          type: 'checkbox',
          checked: state.hideFromCapture,
          click: actions.toggleHideFromCapture
        },
        { type: 'separator' },
        { label: 'Quit Suri', click: actions.quit }
      ])
    )
  }

  tray.on('click', actions.open)
  refresh()
  return { refresh, destroy: () => tray.destroy() }
}

function statusLine(state: TrayState): string {
  if (state.hookServer.state === 'error') return state.hookServer.message
  if (state.paused) return 'Paused'
  if (state.sessions === 0) return 'Watching for Claude Code'
  return state.sessions === 1 ? '1 Claude Code session' : `${state.sessions} Claude Code sessions`
}
