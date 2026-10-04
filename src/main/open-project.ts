import { shell } from 'electron'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { vscodeFolderUrl } from './vscode-url'

/**
 * Opens a session's folder in VS Code through the vscode:// protocol, so no
 * shell or command line ever sees the path (it comes from a hook payload).
 * Falls back to Explorer when VS Code isn't registered.
 */
export async function openProjectFolder(folder: string): Promise<boolean> {
  if (!isAbsolute(folder)) return false
  try {
    if (!statSync(folder).isDirectory()) return false
  } catch {
    return false
  }
  try {
    await shell.openExternal(vscodeFolderUrl(folder))
    return true
  } catch {
    return (await shell.openPath(folder)) === ''
  }
}
