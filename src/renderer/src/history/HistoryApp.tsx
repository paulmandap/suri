import { useEffect, useState } from 'react'
import { dayLabel, dayTitle, durationLabel, type TurnView } from '@shared/history'
import type { DayView, DaysView } from '@shared/history-ipc'
import { MascotHead } from '../mascot/Mascot'
import { Notice } from '../settings/ui'
import { DigestCard } from './DigestCard'
import { TurnCard } from './TurnCard'

/** The days list and the shown day, kept fresh when main says history changed. */
function useHistory(): {
  days: DaysView | null
  day: string | null
  view: DayView | null
  select: (day: string) => void
} {
  const [days, setDays] = useState<DaysView | null>(null)
  const [day, setDay] = useState<string | null>(null)
  const [view, setView] = useState<DayView | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.suriHistory.getDays().then((next) => {
        if (!alive || !next) return
        setDays(next)
        setDay((current) => current ?? next.today)
      })
    }
    load()
    const offChanged = window.suriHistory.onChanged(load)
    const offShow = window.suriHistory.onShowDay(setDay)
    return () => {
      alive = false
      offChanged()
      offShow()
    }
  }, [])

  // The shown day: again whenever the days list was refreshed (something changed).
  useEffect(() => {
    if (!day) return
    let alive = true
    void window.suriHistory.getDay(day).then((next) => {
      if (alive) setView(next)
    })
    return () => {
      alive = false
    }
  }, [day, days])

  return { days, day, view: view && view.day === day ? view : null, select: setDay }
}

export function HistoryApp(): React.JSX.Element {
  const { days, day, view, select } = useHistory()

  return (
    <div className="flex h-full flex-col text-zinc-200">
      <header className="app-drag flex h-10 shrink-0 items-center gap-2 pl-4 pr-[150px]">
        <MascotHead mood="idle" size={18} />
        <span className="text-[12.5px] font-semibold text-zinc-100">Suri</span>
        <span className="text-[12.5px] text-zinc-500">History</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-48 shrink-0 overflow-y-auto px-3 pb-6 pt-3" aria-label="Days">
          {days?.days.map((d) => (
            <button
              key={d.day}
              type="button"
              aria-current={d.day === day ? 'page' : undefined}
              onClick={() => select(d.day)}
              className={`mb-0.5 flex w-full items-center rounded-lg px-3 py-1.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-teal-300/70 ${
                d.day === day
                  ? 'bg-white/[0.08] text-zinc-50'
                  : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
              }`}
            >
              {dayLabel(d.day, days.today)}
              <span className="ml-auto text-[11.5px] tabular-nums text-zinc-500">
                {d.turns || ''}
              </span>
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto px-8 pb-12 pt-3">
          {days?.unavailable ? (
            <Notice tone="error">History is off: {days.unavailable}</Notice>
          ) : !day || !view ? (
            <p className="text-[13px] text-zinc-500">Loading…</p>
          ) : (
            <DayPane view={view} today={days?.today ?? day} />
          )}
        </main>
      </div>
    </div>
  )
}

function DayPane({ view, today }: { view: DayView; today: string }): React.JSX.Element {
  const groups = byProject(view.turns)
  return (
    <div>
      <h1 className="text-[18px] font-semibold text-zinc-50">{dayTitle(view.day)}</h1>
      <p className="mt-0.5 text-[12.5px] text-zinc-500">
        {view.turns.length === 0
          ? view.day === today
            ? 'Nothing yet today. Requests to Claude Code show up here as they finish.'
            : 'No requests on this day.'
          : `${plural(view.turns.length, 'request')} in ${plural(groups.length, 'project')}`}
      </p>

      {/* Keyed by day: a "Copied" or "Saved" note belongs to that day's notes only. */}
      {view.turns.length > 0 && <DigestCard key={view.day} day={view.day} status={view.digest} />}

      {groups.map(({ project, turns }) => (
        <section key={project} className="mt-7">
          <h2 className="mb-2.5 flex items-baseline gap-2">
            <span className="text-[14px] font-semibold text-zinc-100">{project}</span>
            <span className="text-[12px] text-zinc-500">
              {plural(turns.length, 'request')}
              {totalMs(turns) >= 60_000 ? ` · about ${durationLabel(totalMs(turns))}` : ''}
            </span>
          </h2>
          <div className="flex flex-col gap-2">
            {turns.map((turn) => (
              <TurnCard key={turn.id} turn={turn} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** Projects by their latest request; turns stay newest first. */
function byProject(turns: readonly TurnView[]): { project: string; turns: TurnView[] }[] {
  const groups = new Map<string, TurnView[]>()
  for (const turn of turns) {
    const list = groups.get(turn.project) ?? []
    list.push(turn)
    groups.set(turn.project, list)
  }
  return [...groups.entries()].map(([project, list]) => ({ project, turns: list }))
}

function totalMs(turns: readonly TurnView[]): number {
  return turns.reduce((sum, turn) => sum + (turn.facts?.durationMs ?? 0), 0)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
