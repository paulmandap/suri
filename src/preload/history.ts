import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { HISTORY_IPC, type SuriHistoryApi } from '@shared/history-ipc'

// The History window's preload. Sandboxed like the others, so at runtime it
// may only import `electron`. It exposes `window.suriHistory` and nothing else.

const api: SuriHistoryApi = {
  getDays: () => ipcRenderer.invoke(HISTORY_IPC.getDays),
  getDay: (day) => ipcRenderer.invoke(HISTORY_IPC.getDay, String(day)),
  onChanged(callback) {
    const listener = (): void => callback()
    ipcRenderer.on(HISTORY_IPC.changed, listener)
    return () => {
      ipcRenderer.removeListener(HISTORY_IPC.changed, listener)
    }
  },
  onShowDay(callback) {
    const listener = (_event: IpcRendererEvent, day: unknown): void => {
      if (typeof day === 'string') callback(day)
    }
    ipcRenderer.on(HISTORY_IPC.showDay, listener)
    return () => {
      ipcRenderer.removeListener(HISTORY_IPC.showDay, listener)
    }
  },
  writeDigest: (day) => ipcRenderer.invoke(HISTORY_IPC.writeDigest, String(day)),
  copyDigest: (day) => ipcRenderer.invoke(HISTORY_IPC.copyDigest, String(day)),
  saveDigest: (day) => ipcRenderer.invoke(HISTORY_IPC.saveDigest, String(day)),
  writeRecap: (turnId) => ipcRenderer.invoke(HISTORY_IPC.writeRecap, Number(turnId))
}

contextBridge.exposeInMainWorld('suriHistory', api)
