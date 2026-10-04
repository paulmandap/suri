import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type SuriApi } from '@shared/ipc'
import type { IslandSnapshot } from '@shared/types'

// This preload runs sandboxed, so at runtime it may only import `electron`
// (electron-vite leaves npm packages external, and a sandboxed preload can't
// load them). The renderer gets this small, typed API and nothing else.
const api: SuriApi = {
  onSnapshot(callback) {
    const listener = (_event: IpcRendererEvent, snapshot: IslandSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on(IPC.snapshot, listener)
    return () => {
      ipcRenderer.removeListener(IPC.snapshot, listener)
    }
  },
  onOpenIsland(callback) {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.openIsland, listener)
    return () => {
      ipcRenderer.removeListener(IPC.openIsland, listener)
    }
  },
  rendererReady: () => ipcRenderer.send(IPC.rendererReady),
  setInteractive: (interactive) => ipcRenderer.send(IPC.setInteractive, interactive === true),
  openSession: (sessionId) => ipcRenderer.invoke(IPC.openSession, String(sessionId)),
  decideApproval: (approvalId, decision) =>
    ipcRenderer.invoke(IPC.decideApproval, String(approvalId), String(decision))
}

contextBridge.exposeInMainWorld('suri', api)
