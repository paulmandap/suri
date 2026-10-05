import { useState } from 'react'
import type { HookAction } from '@shared/hook-config'
import type { HookPreview, HooksView } from '@shared/settings-ipc'
import type { HookState } from '@shared/types'
import { DiffView } from './DiffView'
import { Button, Card, Notice, Path, Section, type NoticeTone } from './ui'

const STATUS: Record<HookState, { title: string; dot: string; text: string }> = {
  installed: {
    title: 'Connected',
    dot: 'bg-emerald-400',
    text: "Claude Code sends every session's events to Suri, in any project."
  },
  'not-installed': {
    title: 'Not installed',
    dot: 'bg-amber-400',
    text: 'Suri only sees projects that have their own hooks. Install them here to see every Claude Code session on this PC.'
  },
  outdated: { title: 'Needs an update', dot: 'bg-amber-400', text: '' },
  unreadable: { title: "Can't read settings.json", dot: 'bg-red-400', text: '' }
}

interface Message {
  tone: NoticeTone
  text: string
  /** The backup this change wrote, shown with a "Show" link. */
  backup?: string | null
}

export function ClaudeCodePane({ hooks }: { hooks: HooksView }): React.JSX.Element {
  const { inspection } = hooks
  const status = STATUS[inspection.state]
  const [preview, setPreview] = useState<HookPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const runPreview = async (action: HookAction, note: Message | null = null): Promise<void> => {
    setBusy(true)
    setMessage(note)
    const result = await window.suriSettings.previewHooks(action)
    setBusy(false)
    if (result.ok) setPreview(result.preview)
    else {
      setPreview(null)
      setMessage({ tone: 'error', text: result.message })
    }
  }

  // Called straight from the click, so the preload sees a real user action.
  const apply = (target: HookPreview): void => {
    setBusy(true)
    void window.suriSettings.applyHooks(target.id).then((result) => {
      setBusy(false)
      if (result.ok) {
        setPreview(null)
        setMessage({ tone: 'ok', text: doneText(target), backup: result.backup })
      } else if (result.reason === 'changed') {
        // Claude Code (or an editor) saved the file meanwhile: show the new diff.
        void runPreview(target.action, {
          tone: 'info',
          text: 'settings.json changed after the preview, so nothing was written. Here is a fresh preview.'
        })
      } else {
        setPreview(null)
        setMessage({ tone: 'error', text: result.message })
      }
    })
  }

  const canInstall = inspection.state === 'not-installed' || inspection.state === 'outdated'
  const canRemove = inspection.suriHooks > 0 && inspection.state !== 'unreadable'

  return (
    <div>
      <Section title="Claude Code hooks">
        <Card>
          <div className="flex items-center gap-2.5">
            <span className={`h-2.5 w-2.5 rounded-full ${status.dot}`} />
            <span className="text-[15px] font-semibold text-zinc-50">{status.title}</span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-400">
            {inspection.detail ?? status.text}
          </p>
          {inspection.state === 'unreadable' && (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-400">
              Suri won&apos;t change a file it can&apos;t read. Fix it by hand, then come back.
            </p>
          )}
          {inspection.warnings.map((warning) => (
            <p key={warning} className="mt-2 text-[12.5px] leading-relaxed text-amber-200">
              {warning}
            </p>
          ))}

          <dl className="mt-4 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
            <dt className="text-zinc-500">File</dt>
            <dd className="min-w-0">
              <Path>{hooks.file}</Path>
              {!hooks.exists && <span className="text-zinc-500"> (not created yet)</span>}
            </dd>
            <dt className="text-zinc-500">Sends to</dt>
            <dd>
              <Path>{hooks.url}</Path>
            </dd>
            <dt className="text-zinc-500">Other hooks</dt>
            <dd className="text-zinc-300">
              {inspection.otherHooks === 0
                ? 'None'
                : `${inspection.otherHooks} from other tools. Suri leaves them alone.`}
            </dd>
          </dl>

          {!preview && (
            <div className="mt-5 flex flex-wrap gap-2">
              {canInstall && (
                <Button tone="primary" disabled={busy} onClick={() => void runPreview('install')}>
                  {inspection.state === 'outdated' ? 'Preview update' : 'Preview install'}
                </Button>
              )}
              {canRemove && (
                <Button disabled={busy} onClick={() => void runPreview('uninstall')}>
                  Preview removal
                </Button>
              )}
              <Button onClick={() => void window.suriSettings.reveal('settings-file')}>
                Show in Explorer
              </Button>
            </div>
          )}
        </Card>
      </Section>

      {message && (
        <div className="mt-4">
          <Notice tone={message.tone}>
            {message.text}
            {message.backup && (
              <span className="mt-1 block">
                Backup: <Path>{message.backup}</Path>{' '}
                <button
                  type="button"
                  onClick={() => void window.suriSettings.reveal('last-backup')}
                  className="ml-1 underline underline-offset-2 hover:text-white"
                >
                  Show
                </button>
              </span>
            )}
          </Notice>
        </div>
      )}

      {preview && (
        <PreviewPanel
          preview={preview}
          busy={busy}
          onCancel={() => setPreview(null)}
          onApply={() => apply(preview)}
        />
      )}

      {inspection.state === 'installed' && !preview && (
        <p className="mt-5 text-[12px] leading-relaxed text-zinc-500">
          While Suri is closed, Claude Code shows &ldquo;Stop hook error&rdquo; once per turn and
          otherwise carries on. Remove the hooks here if you stop using Suri.
        </p>
      )}
    </div>
  )
}

function PreviewPanel({
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

function doneText(preview: HookPreview): string {
  const what =
    preview.action === 'uninstall'
      ? "Removed Suri's hooks."
      : preview.suriBefore > 0
        ? "Updated Suri's hooks."
        : "Installed Suri's hooks."
  return `${what} Claude Code picks the change up by itself; if a running session doesn't, restart it.`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
