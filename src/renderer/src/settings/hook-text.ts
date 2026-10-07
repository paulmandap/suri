import type { HookPreview } from '@shared/settings-ipc'

// Words about hook changes, shared by the Settings and Uninstall windows.

/** What a written change did, for the message after the click. */
export function doneText(preview: HookPreview): string {
  const what =
    preview.action === 'uninstall'
      ? "Removed Suri's hooks."
      : preview.suriBefore > 0
        ? "Updated Suri's hooks."
        : "Installed Suri's hooks."
  return `${what} Claude Code picks the change up by itself; if a running session doesn't, restart it.`
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
