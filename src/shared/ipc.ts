import type { AskEvent, AskStart, LoadResult } from './file-qa'
import type { ApprovalDecision, IslandSnapshot } from './types'

/** Every IPC channel between the main process and the island renderer. */
export const IPC = {
  /** main → renderer: open the island on the file panel (tray → Ask about a file). */
  openAsk: 'suri:open-ask',
  /** renderer → main: the file panel opened or closed; focus and clicks follow (ADR-027). */
  setAskOpen: 'suri:set-ask-open',
  /** renderer → main (invoke): show an Open dialog and read the chosen file. */
  chooseFile: 'suri:choose-file',
  /** renderer → main (invoke): a dropped file's name and bytes. Never a path. */
  loadFile: 'suri:load-file',
  /** renderer → main (invoke): ask about the loaded file. The answer comes as askEvent. */
  ask: 'suri:ask',
  /** renderer → main: stop an answer on its way. */
  cancelAsk: 'suri:cancel-ask',
  /** main → renderer: a piece of an answer, or its end. */
  askEvent: 'suri:ask-event',
  /** renderer → main (invoke): copy text (a code block) to the clipboard. */
  copyText: 'suri:copy-text',
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
  onOpenAsk(callback: () => void): () => void
  setAskOpen(open: boolean): void
  chooseFile(): Promise<LoadResult>
  loadFile(name: string, bytes: Uint8Array): Promise<LoadResult>
  ask(question: string): Promise<AskStart>
  cancelAsk(id: string): void
  onAskEvent(callback: (event: AskEvent) => void): () => void
  copyText(text: string): Promise<boolean>
}
