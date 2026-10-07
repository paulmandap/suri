import { useState } from 'react'
import {
  durationLabel,
  linesLabel,
  turnTitle,
  type DecisionOutcome,
  type RecapOutcome,
  type TurnStatus,
  type TurnView
} from '@shared/history'

const OUTCOME: Record<RecapOutcome, { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'bg-emerald-400/15 text-emerald-200' },
  partial: { label: 'Partly done', tone: 'bg-amber-400/15 text-amber-200' },
  'needs-input': { label: 'Needs your answer', tone: 'bg-sky-400/15 text-sky-200' },
  failed: { label: "Couldn't finish", tone: 'bg-red-400/15 text-red-200' }
}

const STATUS: Record<TurnStatus, { label: string; tone: string }> = {
  done: { label: 'Finished', tone: 'bg-white/[0.07] text-zinc-300' },
  running: { label: 'Running', tone: 'bg-teal-400/15 text-teal-200' },
  error: { label: 'Error', tone: 'bg-red-400/15 text-red-200' },
  interrupted: { label: 'Interrupted', tone: 'bg-white/[0.07] text-zinc-400' }
}

const DECISION: Record<DecisionOutcome, string> = {
  allow: 'Allowed',
  deny: 'Denied',
  ask: 'Asked in Claude Code',
  timeout: 'Timed out',
  gone: 'Closed'
}

const MARK = {
  ok: { sign: '✓', tone: 'text-emerald-300' },
  failed: { sign: '✕', tone: 'text-red-300' },
  stopped: { sign: '–', tone: 'text-zinc-500' }
} as const

/** One request: its recap up top, the facts underneath on demand. */
export function TurnCard({ turn }: { turn: TurnView }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const chip = turn.recap ? OUTCOME[turn.recap.outcome] : STATUS[turn.status]
  const facts = turn.facts
  const summary = turn.recap?.summary ?? turn.error ?? (turn.prompt ? turn.lastMessage : undefined)

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70"
      >
        <span className="mt-0.5 w-11 shrink-0 text-[12px] tabular-nums text-zinc-500">
          {timeOf(turn.startedAt)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${chip.tone}`}>
              {chip.label}
            </span>
            <span className="truncate text-[13.5px] font-medium text-zinc-100">
              {turnTitle(turn)}
            </span>
          </span>
          {summary && (
            <span className="mt-1 line-clamp-2 block text-[12.5px] leading-snug text-zinc-400">
              {summary}
            </span>
          )}
          {facts && (
            <span className="mt-1 block text-[11.5px] text-zinc-500">{factsLine(turn)}</span>
          )}
        </span>
        <span className="mt-0.5 shrink-0 text-[11px] text-zinc-600">{open ? 'Less' : 'More'}</span>
      </button>
      {open && <TurnDetails turn={turn} />}
    </div>
  )
}

function TurnDetails({ turn }: { turn: TurnView }): React.JSX.Element {
  const facts = turn.facts
  const canWrite = turn.status !== 'running' && turn.recapState !== 'pending'
  return (
    <div className="mt-3 select-text space-y-3 border-t border-white/[0.06] pl-14 pt-3 text-[12.5px]">
      {turn.prompt && (
        <Block title="Request">
          <p className="whitespace-pre-wrap leading-snug text-zinc-300">{turn.prompt}</p>
        </Block>
      )}
      {facts && facts.filesChanged.length > 0 && (
        <Block title="Files changed">
          <ul className="space-y-0.5">
            {facts.filesChanged.map((file) => (
              <li key={file.path} className="flex gap-2 font-mono text-[11.5px] text-zinc-300">
                <span className="truncate">{file.path}</span>
                <span className="shrink-0 text-zinc-500">
                  {linesLabel(file.added, file.removed)}
                </span>
              </li>
            ))}
          </ul>
          {facts.moreFiles > 0 && <More n={facts.moreFiles} what="file" />}
        </Block>
      )}
      {facts && facts.commands.length > 0 && (
        <Block title="Commands">
          {facts.moreCommands > 0 && <More n={facts.moreCommands} what="earlier command" />}
          <ul className="space-y-0.5">
            {facts.commands.map((run, i) => (
              <li key={i} className="flex gap-2 font-mono text-[11.5px] text-zinc-300">
                <span className={`shrink-0 ${MARK[run.status].tone}`}>{MARK[run.status].sign}</span>
                <span className="break-all">{run.command}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {turn.decisions.length > 0 && (
        <Block title="Approvals">
          <ul className="space-y-0.5">
            {turn.decisions.map((d, i) => (
              <li key={i} className="flex gap-2 text-[12px] text-zinc-300">
                <span className="shrink-0 text-zinc-500">{DECISION[d.outcome]}</span>
                <span className="break-all font-mono text-[11.5px]">{d.detail}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {turn.recap && turn.recap.followUps.length > 0 && (
        <Block title="Left to do">
          <ul className="list-disc space-y-0.5 pl-4 text-zinc-300 marker:text-zinc-600">
            {turn.recap.followUps.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Block>
      )}
      {turn.lastMessage && (
        <Block title="Claude's last message">
          <p className="whitespace-pre-wrap leading-snug text-zinc-400">{turn.lastMessage}</p>
        </Block>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-zinc-500">
        <span>{recapLine(turn)}</span>
        {canWrite && (
          <button
            type="button"
            onClick={() => void window.suriHistory.writeRecap(turn.id)}
            className="text-zinc-400 underline underline-offset-2 outline-none hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-teal-300/70"
          >
            {turn.recap ? 'Write it again' : 'Write a recap'}
          </button>
        )}
      </div>
    </div>
  )
}

function Block({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-zinc-500">
        {title}
      </div>
      {children}
    </div>
  )
}

function More({ n, what }: { n: number; what: string }): React.JSX.Element {
  return (
    <div className="text-[11.5px] text-zinc-500">
      and {n} more {what}
      {n === 1 ? '' : 's'}
    </div>
  )
}

function recapLine(turn: TurnView): string {
  if (turn.recap) {
    const fell = turn.recap.fellBackFrom ? ` (Gemini: ${turn.recap.fellBackFrom})` : ''
    return `Recap by ${turn.recap.model}${fell}`
  }
  if (turn.recapState === 'pending') return 'Writing a recap…'
  if (turn.recapState === 'failed')
    return `No recap: ${turn.recapNote ?? 'the model gave no answer.'}`
  return 'No recap'
}

function factsLine(turn: TurnView): string {
  const f = turn.facts
  if (!f) return ''
  const parts = [`${f.steps} ${f.steps === 1 ? 'step' : 'steps'}`]
  const files = f.filesChanged.length + f.moreFiles
  if (files > 0) {
    const lines = linesLabel(f.linesAdded, f.linesRemoved)
    parts.push(`${files} ${files === 1 ? 'file' : 'files'}${lines ? ` ${lines}` : ''}`)
  }
  const failed = f.commands.filter((c) => c.status === 'failed').length
  if (failed > 0) parts.push(`${failed} failed ${failed === 1 ? 'command' : 'commands'}`)
  if (f.durationMs >= 1000) parts.push(durationLabel(f.durationMs))
  return parts.join(' · ')
}

function timeOf(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
