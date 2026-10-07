import { useEffect, useState } from 'react'
import type { HookPreview } from '@shared/settings-ipc'
import type { UninstallView } from '@shared/uninstall-ipc'
import { MascotHead } from '../mascot/Mascot'
import { PreviewPanel } from '../settings/HookPreview'
import { doneText, plural } from '../settings/hook-text'
import { Button, Card, Notice, Path, Section, ToggleRow, type NoticeTone } from '../settings/ui'

// The Uninstall window (ADR-031). Windows is removing Suri: Paul decides what
// happens to Claude Code's hooks and to Suri's data. Nothing changes without a
// click, and closing the window keeps everything.

interface Message {
  tone: NoticeTone
  text: string
}

export function UninstallApp(): React.JSX.Element {
  const [view, setView] = useState<UninstallView | null>(null)
  const [preview, setPreview] = useState<HookPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [deleteData, setDeleteData] = useState(false)
  const [finishProblem, setFinishProblem] = useState<string | null>(null)

  const refresh = (): Promise<void> => window.suriUninstall.getView().then(setView)
  useEffect(() => {
    void refresh()
  }, [])

  const runPreview = async (note: Message | null = null): Promise<void> => {
    setBusy(true)
    setMessage(note)
    const result = await window.suriUninstall.previewRemoval()
    setBusy(false)
    if (result.ok) setPreview(result.preview)
    else setMessage({ tone: 'error', text: result.message })
  }

  // Called straight from the click, so the preload sees a real user action.
  const apply = (target: HookPreview): void => {
    setBusy(true)
    void window.suriUninstall.applyRemoval(target.id).then(async (result) => {
      setBusy(false)
      if (result.ok) {
        setPreview(null)
        setMessage({
          tone: 'ok',
          text: `${doneText(target)}${result.backup ? ` A copy of the old file: ${result.backup}` : ''}`
        })
        await refresh()
      } else if (result.reason === 'changed') {
        void runPreview({
          tone: 'info',
          text: 'settings.json changed after the preview, so nothing was written. Here is a fresh preview.'
        })
      } else {
        setPreview(null)
        setMessage({ tone: 'error', text: result.message })
      }
    })
  }

  const finish = (): void => {
    setBusy(true)
    setFinishProblem(null)
    void window.suriUninstall.finish(deleteData).then((result) => {
      // On success main closes the window, and the uninstaller carries on.
      if (!result.ok) {
        setBusy(false)
        setFinishProblem(result.message)
      }
    })
  }

  return (
    <div className="flex h-full flex-col text-zinc-200">
      <header className="app-drag flex h-10 shrink-0 items-center gap-2 pl-4 pr-[150px]">
        <MascotHead mood="sleepy" size={18} />
        <span className="text-[12.5px] font-semibold text-zinc-100">Suri</span>
        <span className="text-[12.5px] text-zinc-500">Uninstall</span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-3">
        <h1 className="text-[17px] font-semibold text-zinc-50">Before Suri goes</h1>
        <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">
          Windows is removing Suri. Two things are left for you to decide. Nothing changes until you
          click, and closing this window keeps everything as it is.
        </p>

        {!view ? (
          <p className="mt-6 text-[13px] text-zinc-500">Loading…</p>
        ) : (
          <>
            <div className="mt-6">
              <HooksCard
                view={view}
                busy={busy}
                showButton={!preview}
                onPreview={() => void runPreview()}
              />
            </div>
            {message && (
              <div className="mt-4">
                <Notice tone={message.tone}>{message.text}</Notice>
              </div>
            )}
            {preview && (
              <div className="mt-7">
                <PreviewPanel
                  preview={preview}
                  busy={busy}
                  onCancel={() => setPreview(null)}
                  onApply={() => apply(preview)}
                />
              </div>
            )}

            <div className="mt-7">
              <Section title="Your data">
                <Card>
                  {view.data.exists ? (
                    <>
                      <ToggleRow
                        label="Also delete my history, settings and saved Gemini key"
                        hint="Off: they stay, ready if you install Suri again."
                        checked={deleteData}
                        disabled={busy}
                        onChange={setDeleteData}
                      />
                      <p className="mt-3 text-[12px] text-zinc-500">
                        <Path>{view.data.folder}</Path>
                      </p>
                    </>
                  ) : (
                    <p className="text-[12.5px] text-zinc-400">Suri has no data on this PC.</p>
                  )}
                </Card>
              </Section>
            </div>

            {finishProblem && (
              <div className="mt-4">
                <Notice tone="error">{finishProblem}</Notice>
              </div>
            )}
            <div className="mt-6 flex items-center gap-3">
              <Button tone={deleteData ? 'danger' : 'primary'} disabled={busy} onClick={finish}>
                {deleteData ? 'Delete my data and finish' : 'Finish'}
              </Button>
              <span className="text-[12px] text-zinc-500">
                The uninstaller carries on after this.
              </span>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function HooksCard({
  view,
  busy,
  showButton,
  onPreview
}: {
  view: UninstallView
  busy: boolean
  showButton: boolean
  onPreview: () => void
}): React.JSX.Element {
  const { inspection, file } = view.hooks
  const unreadable = inspection.state === 'unreadable'
  const count = inspection.suriHooks
  return (
    <Section title="Claude Code hooks">
      <Card>
        {unreadable ? (
          <p className="text-[12.5px] leading-relaxed text-amber-200">
            {inspection.detail} Suri won&apos;t change a file it can&apos;t read. Remove its hooks
            by hand: the ones that send to <span className="font-mono">127.0.0.1</span> and end in{' '}
            <span className="font-mono">/hooks</span>.
          </p>
        ) : count > 0 ? (
          <p className="text-[12.5px] leading-relaxed text-zinc-300">
            Claude Code still sends its events to Suri ({plural(count, 'hook')}). Without Suri,
            every Claude Code turn would show &ldquo;Stop hook error&rdquo;. Removing them leaves
            your other settings and hooks as they are.
          </p>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-zinc-300">
            Claude Code has no Suri hooks. Nothing to remove.
          </p>
        )}
        <p className="mt-2 text-[12px] text-zinc-500">
          <Path>{file}</Path>
        </p>
        {showButton && count > 0 && !unreadable && (
          <div className="mt-4">
            <Button tone="primary" disabled={busy} onClick={onPreview}>
              Preview removal
            </Button>
          </div>
        )}
      </Card>
    </Section>
  )
}
