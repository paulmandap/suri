import type { ReactNode } from 'react'

// Small building blocks for the Settings window.

export function Section({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-7 first:mt-0">
      <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
        {title}
      </h2>
      {children}
    </section>
  )
}

export function Card({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-5 py-4">
      {children}
    </div>
  )
}

const BUTTON = {
  primary: 'bg-teal-400 text-black hover:bg-teal-300 disabled:bg-teal-400/40',
  danger: 'bg-red-400/90 text-black hover:bg-red-300 disabled:bg-red-400/40',
  quiet: 'bg-white/[0.07] text-zinc-200 hover:bg-white/[0.12] disabled:text-zinc-500'
} as const

export function Button({
  tone = 'quiet',
  disabled,
  onClick,
  children
}: {
  tone?: keyof typeof BUTTON
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70 disabled:cursor-not-allowed ${BUTTON[tone]}`}
    >
      {children}
    </button>
  )
}

/** One setting: a label, a line of explanation, and a switch. */
export function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string
  hint: ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className={`text-[13.5px] ${disabled ? 'text-zinc-500' : 'text-zinc-100'}`}>
          {label}
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-zinc-500">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-[22px] w-10 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70 disabled:cursor-not-allowed disabled:opacity-40 ${
          checked ? 'bg-teal-400' : 'bg-white/15'
        }`}
      >
        <span
          className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-[left] ${
            checked ? 'left-[21px]' : 'left-[3px]'
          }`}
        />
      </button>
    </div>
  )
}

const NOTICE = {
  ok: 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-100',
  info: 'border-sky-400/25 bg-sky-400/[0.07] text-sky-100',
  warn: 'border-amber-400/25 bg-amber-400/[0.07] text-amber-100',
  error: 'border-red-400/30 bg-red-400/[0.08] text-red-100'
} as const

export type NoticeTone = keyof typeof NOTICE

export function Notice({
  tone,
  children
}: {
  tone: NoticeTone
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl border px-4 py-2.5 text-[12.5px] leading-relaxed ${NOTICE[tone]}`}
    >
      {children}
    </div>
  )
}

/** A file path the user may want to copy: selectable, monospace, wraps anywhere. */
export function Path({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="select-text break-all font-mono text-[11.5px] text-zinc-300">{children}</span>
  )
}
