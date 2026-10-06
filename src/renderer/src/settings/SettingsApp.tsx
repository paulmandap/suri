import { useEffect, useState } from 'react'
import type { SettingsView } from '@shared/settings-ipc'
import { MascotHead } from '../mascot/Mascot'
import { AiPane } from './AiPane'
import { ClaudeCodePane } from './ClaudeCodePane'
import { GeneralPane } from './GeneralPane'

type Tab = 'claude' | 'general' | 'ai'

const TABS: { id: Tab; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' }
]

/** Main pushes a fresh view after every change (tray toggles included). */
function useSettingsView(): SettingsView | null {
  const [view, setView] = useState<SettingsView | null>(null)
  useEffect(() => {
    let alive = true
    const off = window.suriSettings.onView(setView)
    void window.suriSettings.getView().then((first) => {
      if (alive && first) setView(first)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return view
}

export function SettingsApp(): React.JSX.Element {
  const view = useSettingsView()
  const [tab, setTab] = useState<Tab>('claude')
  const needsHooks = view !== null && view.hooks.inspection.state !== 'installed'

  return (
    <div className="flex h-full flex-col text-zinc-200">
      {/* Our title bar: drag it to move the window; Windows draws the buttons on the right. */}
      <header className="app-drag flex h-10 shrink-0 items-center gap-2 pl-4 pr-[150px]">
        <MascotHead mood="idle" size={18} />
        <span className="text-[12.5px] font-semibold text-zinc-100">Suri</span>
        <span className="text-[12.5px] text-zinc-500">Settings</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-44 shrink-0 px-3 pt-3" aria-label="Settings sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => setTab(item.id)}
              className={`mb-0.5 flex w-full items-center rounded-lg px-3 py-1.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-teal-300/70 ${
                tab === item.id
                  ? 'bg-white/[0.08] text-zinc-50'
                  : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
              }`}
            >
              {item.label}
              {item.id === 'claude' && needsHooks && (
                <span
                  className="ml-auto h-2 w-2 rounded-full bg-amber-400"
                  aria-label="needs attention"
                />
              )}
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto px-8 pb-10 pt-3">
          {!view ? (
            <p className="text-[13px] text-zinc-500">Loading…</p>
          ) : tab === 'claude' ? (
            <ClaudeCodePane hooks={view.hooks} />
          ) : tab === 'general' ? (
            <GeneralPane
              general={view.general}
              server={view.server}
              hooks={view.hooks.inspection.state}
              onShowHooks={() => setTab('claude')}
            />
          ) : (
            <AiPane ai={view.ai} />
          )}
        </main>
      </div>
    </div>
  )
}
