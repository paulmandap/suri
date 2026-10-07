import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AskEvent } from '@shared/file-qa'
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
    ipcRenderer.invoke(IPC.decideApproval, String(approvalId), String(decision)),
  onOpenAsk(callback) {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.openAsk, listener)
    return () => {
      ipcRenderer.removeListener(IPC.openAsk, listener)
    }
  },
  setAskOpen: (open) => ipcRenderer.send(IPC.setAskOpen, open === true),
  chooseFile: () => ipcRenderer.invoke(IPC.chooseFile),
  // Bytes, never a path: main reads only what Paul dropped (ADR-027).
  loadFile: (name, bytes) => ipcRenderer.invoke(IPC.loadFile, String(name), bytes),
  ask: (question) => ipcRenderer.invoke(IPC.ask, String(question)),
  cancelAsk: (id) => ipcRenderer.send(IPC.cancelAsk, String(id)),
  onAskEvent(callback) {
    const listener = (_event: IpcRendererEvent, data: AskEvent): void => callback(data)
    ipcRenderer.on(IPC.askEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.askEvent, listener)
    }
  },
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, String(text))
}

contextBridge.exposeInMainWorld('suri', api)
