import { useState } from 'react'
import { byLine, type Digest } from '@shared/digest'
import type { DigestStatus } from '@shared/history-ipc'
import { Button, Notice } from '../settings/ui'

/** A day's standup notes: write them, then copy or save them as Markdown. */
export function DigestCard({
  day,
  status
}: {
  day: string
  status: DigestStatus
}): React.JSX.Element {
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const { digest, writing, newTurns } = status

  const write = (): void => {
    setMessage(null)
    void window.suriHistory.writeDigest(day)
  }
  const copy = async (): Promise<void> => {
    const ok = await window.suriHistory.copyDigest(day)
    setMessage(
      ok ? { tone: 'ok', text: 'Copied as Markdown.' } : { tone: 'error', text: "Couldn't copy." }
    )
  }
  const save = async (): Promise<void> => {
    const result = await window.suriHistory.saveDigest(day)
    if (result.ok) setMessage({ tone: 'ok', text: `Saved to ${result.path}` })
    else if (!result.cancelled) setMessage({ tone: 'error', text: result.message })
  }

  return (
    <div className="mt-5 rounded-2xl border border-teal-300/15 bg-teal-300/[0.04] px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-teal-200/80">
          Standup notes
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {digest && !writing && (
            <>
              <Button onClick={() => void copy()}>Copy</Button>
              <Button onClick={() => void save()}>Save as .md</Button>
            </>
          )}
          <Button tone={digest ? 'quiet' : 'primary'} disabled={writing} onClick={write}>
            {writing ? 'Writing…' : digest ? 'Rewrite' : 'Write the notes'}
          </Button>
        </div>
      </div>

      {writing && (
        <p className="mt-3 text-[12.5px] text-zinc-400">
          Writing the notes… A local model can take up to a minute to load.
        </p>
      )}
      {!writing && !digest && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-zinc-400">
          Turns this day&apos;s requests into standup notes: what&apos;s done, what&apos;s in
          progress, blockers and next steps. The digest model is set in Settings → AI.
        </p>
      )}
      {digest && <DigestBody digest={digest} dim={writing} />}
      {digest && !writing && newTurns > 0 && (
        <p className="mt-3 text-[12px] text-amber-200/80">
          {newTurns === 1 ? '1 request' : `${newTurns} requests`} came in after these were written.
          Rewrite to add {newTurns === 1 ? 'it' : 'them'}.
        </p>
      )}
      {message && (
        <div className="mt-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
    </div>
  )
}

function DigestBody({ digest, dim }: { digest: Digest; dim: boolean }): React.JSX.Element {
  return (
    <div className={`mt-3 select-text ${dim ? 'opacity-50' : ''}`}>
      <p className="text-[13.5px] leading-relaxed text-zinc-100">{digest.headline}</p>
      {digest.projects.map((p) => (
        <div key={p.name} className="mt-3.5">
          <div className="text-[13px] font-semibold text-zinc-100">{p.name}</div>
          <List title="Done" items={p.done} />
          <List title="In progress" items={p.inProgress} />
        </div>
      ))}
      <List title="Blockers" items={digest.blockers} heading />
      <List title="Next" items={digest.next} heading />
      <p className="mt-4 text-[11.5px] text-zinc-500">
        {digest.stats} · {byLine(digest)}
      </p>
      {digest.note && <p className="mt-1 text-[11.5px] text-amber-200/70">{digest.note}</p>}
    </div>
  )
}

function List({
  title,
  items,
  heading = false
}: {
  title: string
  items: readonly string[]
  heading?: boolean
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className={heading ? 'mt-3.5' : 'mt-1.5'}>
      <div
        className={
          heading ? 'text-[13px] font-semibold text-zinc-100' : 'text-[11.5px] text-zinc-500'
        }
      >
        {title}
      </div>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] leading-snug text-zinc-300 marker:text-zinc-600">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
