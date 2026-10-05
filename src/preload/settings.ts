import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { SETTINGS_IPC, type SettingsView, type SuriSettingsApi } from '@shared/settings-ipc'

// The Settings window's preload. Sandboxed like the island's, so at runtime it
// may only import `electron`. It exposes `window.suriSettings` and nothing else.

/** True only inside a real click (or key press). A script running on its own has none. */
function clicked(): boolean {
  return navigator.userActivation?.isActive === true
}

const api: SuriSettingsApi = {
  getView: () => ipcRenderer.invoke(SETTINGS_IPC.getView),
  onView(callback) {
    const listener = (_event: IpcRendererEvent, view: SettingsView): void => callback(view)
    ipcRenderer.on(SETTINGS_IPC.view, listener)
    return () => {
      ipcRenderer.removeListener(SETTINGS_IPC.view, listener)
    }
  },
  updateGeneral: (patch) => ipcRenderer.invoke(SETTINGS_IPC.updateGeneral, patch),
  previewHooks: (action) => ipcRenderer.invoke(SETTINGS_IPC.previewHooks, String(action)),
  applyHooks(previewId) {
    // Claude Code's settings change only on Paul's click (CLAUDE.md).
    if (!clicked()) {
      return Promise.resolve({
        ok: false,
        reason: 'no-click',
        message: 'Only a click can change Claude Code settings.'
      })
    }
    return ipcRenderer.invoke(SETTINGS_IPC.applyHooks, String(previewId))
  },
  reveal: (target) => ipcRenderer.invoke(SETTINGS_IPC.reveal, String(target))
}

contextBridge.exposeInMainWorld('suriSettings', api)
