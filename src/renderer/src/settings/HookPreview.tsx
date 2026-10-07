import type { HookPreview } from '@shared/settings-ipc'
import { DiffView } from './DiffView'
import { plural } from './hook-text'
import { Button, Card, Path, Section } from './ui'

// The diff of a hook change before it's written (ADR-013), shared by the
// Settings window and the Uninstall window (ADR-031).

export function PreviewPanel({
  preview,
  busy,
  onCancel,
  onApply
}: {
  preview: HookPreview
  busy: boolean
  onCancel: () => void
  onApply: () => void
}): React.JSX.Element {
  const removing = preview.action === 'uninstall'
  return (
    <Section title={removing ? 'Preview: remove hooks' : 'Preview: install hooks'}>
      <Card>
        <p className="text-[13px] leading-relaxed text-zinc-200">{summary(preview)}</p>
        {preview.changed && (
          <>
            <div className="mb-2 mt-3 flex items-center gap-3 text-[12px]">
              <span className="font-medium text-zinc-300">settings.json</span>
              <span className="text-emerald-300">+{preview.added}</span>
              <span className="text-red-300">−{preview.removed}</span>
              <span className="text-zinc-600">Tokens and keys are hidden here.</span>
            </div>
            <DiffView lines={preview.lines} />
            <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">
              {preview.backupHint ? (
                <>
                  First, Suri saves a copy: <Path>{preview.backupHint}</Path>
                </>
              ) : (
                "There's no settings.json yet, so Suri creates one. Nothing to back up."
              )}
            </p>
          </>
        )}
        <div className="mt-4 flex gap-2">
          {preview.changed && (
            <Button tone={removing ? 'danger' : 'primary'} disabled={busy} onClick={onApply}>
              {applyLabel(preview)}
            </Button>
          )}
          <Button disabled={busy} onClick={onCancel}>
            {preview.changed ? 'Cancel' : 'Close'}
          </Button>
        </div>
      </Card>
    </Section>
  )
}

function applyLabel(preview: HookPreview): string {
  if (preview.action === 'uninstall') return 'Remove hooks'
  return preview.suriBefore > 0 ? 'Update hooks' : 'Install hooks'
}

function summary(preview: HookPreview): string {
  if (!preview.changed) {
    return preview.action === 'install'
      ? 'Suri is already installed exactly like this. Nothing to change.'
      : 'There are no Suri hooks to remove.'
  }
  const others =
    preview.otherHooks === 0
      ? 'Everything else in the file stays as it is.'
      : `Your ${plural(preview.otherHooks, 'other hook')} and everything else stay as they are.`
  if (preview.action === 'uninstall')
    return `Removes Suri's ${plural(preview.suriBefore, 'hook')}. ${others}`
  if (preview.suriBefore > 0) {
    return `Replaces Suri's ${plural(preview.suriBefore, 'old hook')} with ${preview.suriAfter} new ones. ${others}`
  }
  return `Adds ${preview.suriAfter} hooks that send Claude Code's events to Suri. ${others}`
}
