import { contextBridge, ipcRenderer } from 'electron'
import { UNINSTALL_IPC, type SuriUninstallApi } from '@shared/uninstall-ipc'

// The Uninstall window's preload (ADR-031). Sandboxed like the others, so at
// runtime it may only import `electron`. It exposes `window.suriUninstall`.

/** True only inside a real click (or key press). A script running on its own has none. */
function clicked(): boolean {
  return navigator.userActivation?.isActive === true
}

const api: SuriUninstallApi = {
  getView: () => ipcRenderer.invoke(UNINSTALL_IPC.getView),
  previewRemoval: () => ipcRenderer.invoke(UNINSTALL_IPC.previewRemoval),
  applyRemoval(previewId) {
    // Claude Code's settings change only on Paul's click (CLAUDE.md).
    if (!clicked()) {
      return Promise.resolve({
        ok: false,
        reason: 'no-click',
        message: 'Only a click can change Claude Code settings.'
      })
    }
    return ipcRenderer.invoke(UNINSTALL_IPC.applyRemoval, String(previewId))
  },
  finish(deleteData) {
    // Deleting the history can't be undone, so only a click may ask for it.
    if (!clicked()) return Promise.resolve({ ok: false, message: 'Only a click can finish.' })
    return ipcRenderer.invoke(UNINSTALL_IPC.finish, deleteData === true)
  }
}

contextBridge.exposeInMainWorld('suriUninstall', api)
