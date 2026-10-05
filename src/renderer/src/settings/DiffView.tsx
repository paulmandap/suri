import type { DiffLine } from '@shared/line-diff'

const ROW = {
  add: { sign: '+', tone: 'bg-emerald-400/[0.09] text-emerald-100' },
  del: { sign: '−', tone: 'bg-red-400/[0.10] text-red-100' },
  same: { sign: ' ', tone: 'text-zinc-400' }
} as const

/** The change to settings.json, line by line, the way a code review shows it. */
export function DiffView({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <div
      className="max-h-[280px] overflow-auto rounded-xl border border-white/[0.08] bg-black/45 py-1.5"
      tabIndex={0}
      aria-label="Changes to settings.json"
    >
      <div className="w-max min-w-full select-text font-mono text-[11.5px] leading-[1.6]">
        {lines.map((line, i) =>
          line.kind === 'gap' ? (
            <div key={i} className="px-3 py-0.5 text-[11px] italic text-zinc-600">
              ⋯ {line.count} unchanged {line.count === 1 ? 'line' : 'lines'}
            </div>
          ) : (
            <div key={i} className={`flex pr-4 ${ROW[line.kind].tone}`}>
              <span className="w-12 shrink-0 select-none pr-3 text-right text-zinc-600">
                {line.line}
              </span>
              <span className="w-4 shrink-0 select-none">{ROW[line.kind].sign}</span>
              <span className="whitespace-pre">{line.text}</span>
            </div>
          )
        )}
      </div>
    </div>
  )
}
