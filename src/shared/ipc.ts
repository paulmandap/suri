import type { ApprovalDecision, IslandSnapshot } from './types'

/** Every IPC channel between the main process and the island renderer. */
export const IPC = {
  /** main → renderer: the full state, after every change. */
  snapshot: 'suri:snapshot',
  /** main → renderer: open the island (tray click, second launch). */
  openIsland: 'suri:open-island',
  /** renderer → main: the UI is mounted and wants the current snapshot. */
  rendererReady: 'suri:renderer-ready',
  /** renderer → main: the pointer entered (true) or left (false) the island. */
  setInteractive: 'suri:set-interactive',
  /** renderer → main (invoke): open a session's folder in VS Code. Resolves to success. */
  openSession: 'suri:open-session',
  /** renderer → main (invoke): answer a held PermissionRequest. Resolves to success. */
  decideApproval: 'suri:decide-approval'
} as const

/** The only API the renderer gets (`window.suri`), exposed by the preload. */
export interface SuriApi {
  onSnapshot(callback: (snapshot: IslandSnapshot) => void): () => void
  onOpenIsland(callback: () => void): () => void
  rendererReady(): void
  setInteractive(interactive: boolean): void
  openSession(sessionId: string): Promise<boolean>
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<boolean>
}
