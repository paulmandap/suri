import { useEffect, useId, useState } from 'react'
import {
  DEFAULT_GEMINI_MODEL,
  FEATURES,
  isLoopbackUrl,
  isValidModel,
  type ConnectionTest,
  type Feature,
  type ProviderId,
  type Route
} from '@shared/ai-config'
import type { AiView } from '@shared/settings-ipc'
import { Button, Card, Notice, Section } from './ui'

const PROVIDER_LABEL: Record<ProviderId, string> = { ollama: 'Ollama', gemini: 'Gemini' }

export function AiPane({ ai }: { ai: AiView }): React.JSX.Element {
  const [ollama, setOllama] = useState<ConnectionTest | null>(null)
  const [gemini, setGemini] = useState<ConnectionTest | null>(null)
  const [testing, setTesting] = useState<ProviderId | null>(null)

  const runTest = async (provider: ProviderId): Promise<void> => {
    setTesting(provider)
    const result = await window.suriSettings.testAi(provider)
    setTesting(null)
    if (provider === 'ollama') setOllama(result)
    else setGemini(result)
  }

  // Ollama runs on this PC, so checking it costs nothing: do it when the tab
  // opens and when its address changes. Gemini only on a click (it's online).
  const { ollamaUrl } = ai.settings
  useEffect(() => {
    let alive = true
    void window.suriSettings.testAi('ollama').then((result) => {
      if (alive) setOllama(result)
    })
    return () => {
      alive = false
    }
  }, [ollamaUrl])

  const installed = ollama?.ok ? ollama.models : null

  return (
    <div>
      <OllamaSection
        ai={ai}
        test={ollama}
        testing={testing === 'ollama'}
        onTest={() => void runTest('ollama')}
        installed={installed}
      />
      <GeminiSection
        ai={ai}
        test={gemini}
        testing={testing === 'gemini'}
        onTest={() => void runTest('gemini')}
        onKeyChanged={() => setGemini(null)}
      />
      <RoutesSection ai={ai} installed={installed} geminiModels={gemini?.ok ? gemini.models : []} />
    </div>
  )
}

function OllamaSection({
  ai,
  test,
  testing,
  onTest,
  installed
}: {
  ai: AiView
  test: ConnectionTest | null
  testing: boolean
  onTest: () => void
  installed: string[] | null
}): React.JSX.Element {
  const [url, setUrl] = useState(ai.settings.ollamaUrl)
  const valid = isLoopbackUrl(url)
  const changed = url !== ai.settings.ollamaUrl

  return (
    <Section title="Local models (Ollama)">
      <Card>
        <label htmlFor="ollama-url" className="text-[13.5px] text-zinc-100">
          Address
        </label>
        <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
          Ollama must run on this PC, so local stays local.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            id="ollama-url"
            type="text"
            value={url}
            aria-invalid={!valid}
            spellCheck={false}
            onChange={(event) => setUrl(event.target.value.trim())}
            className="w-64 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[12.5px] text-zinc-100 outline-none focus:border-teal-300/60 aria-[invalid=true]:border-red-400/60"
          />
          <Button
            tone="primary"
            disabled={!valid || !changed}
            onClick={() => void window.suriSettings.updateAi({ ollamaUrl: url })}
          >
            Save
          </Button>
          <Button disabled={testing} onClick={onTest}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        {!valid && (
          <p className="mt-2 text-[12px] text-red-300">
            Use an address on this PC, like http://127.0.0.1:11434.
          </p>
        )}
        <TestLine test={test} testing={testing} />
        {installed && installed.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {installed.map((model) => (
              <span
                key={model}
                className="rounded-full bg-white/[0.06] px-2.5 py-0.5 font-mono text-[11px] text-zinc-300"
              >
                {model}
              </span>
            ))}
          </div>
        )}

        <div className="mt-5 border-t border-white/[0.06] pt-4">
          <div className="text-[13.5px] text-zinc-100">Fallback model</div>
          <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
            Answers when Gemini can&apos;t: no key, no internet, or the free-tier limit.
          </p>
          <div className="mt-2.5">
            <ModelField
              key={ai.settings.fallbackModel}
              provider="ollama"
              value={ai.settings.fallbackModel}
              suggestions={installed ?? []}
              installed={installed}
              onSave={(fallbackModel) => void window.suriSettings.updateAi({ fallbackModel })}
            />
          </div>
        </div>
      </Card>
    </Section>
  )
}

function GeminiSection({
  ai,
  test,
  testing,
  onTest,
  onKeyChanged
}: {
  ai: AiView
  test: ConnectionTest | null
  testing: boolean
  onTest: () => void
  onKeyChanged: () => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saved = ai.geminiKey === 'saved'

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await window.suriSettings.saveGeminiKey(key)
    setSaving(false)
    if (result.ok) {
      // The page forgets the key as soon as main has it.
      setKey('')
      onKeyChanged()
    } else setError(result.message)
  }

  const remove = async (): Promise<void> => {
    await window.suriSettings.removeGeminiKey()
    onKeyChanged()
  }

  return (
    <Section title="Gemini">
      <Card>
        <div className="flex items-center gap-2.5">
          <span
            className={`h-2.5 w-2.5 rounded-full ${saved ? 'bg-emerald-400' : 'bg-zinc-500'}`}
          />
          <span className="text-[14px] font-semibold text-zinc-50">
            {saved ? 'API key saved' : 'No API key'}
          </span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-400">
          {saved
            ? 'Encrypted with Windows (DPAPI). Suri never shows it again.'
            : 'Get a free key at aistudio.google.com, then paste it here.'}
        </p>
        {!ai.secureStorage && (
          <div className="mt-3">
            <Notice tone="error">
              Windows secure storage isn&apos;t available, so Suri can&apos;t keep a key.
            </Notice>
          </div>
        )}

        <div className="mt-3.5 flex items-center gap-2">
          <input
            type="password"
            value={key}
            placeholder={saved ? 'Paste a new key to replace it' : 'Paste your API key'}
            aria-label="Gemini API key"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && key.trim()) void save()
            }}
            className="w-72 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[12.5px] text-zinc-100 outline-none placeholder:font-sans placeholder:text-zinc-600 focus:border-teal-300/60"
          />
          <Button
            tone="primary"
            disabled={!key.trim() || saving || !ai.secureStorage}
            onClick={() => void save()}
          >
            Save key
          </Button>
          {saved && <Button onClick={() => void remove()}>Remove</Button>}
        </div>
        {error && <p className="mt-2 text-[12px] text-red-300">{error}</p>}

        {saved && (
          <div className="mt-3 flex items-center gap-3">
            <Button disabled={testing} onClick={onTest}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
          </div>
        )}
        <TestLine test={test} testing={testing} />

        <div className="mt-4">
          <Notice tone="info">
            On the free tier, Google may use what Suri sends to improve its products. Suri takes out
            secrets (keys, tokens, passwords) first, and only the features you send to Gemini below
            use it.
          </Notice>
        </div>
      </Card>
    </Section>
  )
}

function RoutesSection({
  ai,
  installed,
  geminiModels
}: {
  ai: AiView
  installed: string[] | null
  geminiModels: string[]
}): React.JSX.Element {
  const setRoute = (feature: Feature, route: Route): void =>
    void window.suriSettings.updateAi({ route: { feature, ...route } })

  return (
    <Section title="Which model does what">
      <Card>
        <div className="divide-y divide-white/[0.06]">
          {FEATURES.map(({ id, label, built }) => {
            const route = ai.settings.routes[id]
            return (
              <div key={id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="w-44 min-w-0">
                  <div className="text-[13.5px] text-zinc-100">{label}</div>
                  {!built && <div className="text-[11px] text-zinc-600">Coming soon</div>}
                </div>
                <ProviderSwitch
                  value={route.provider}
                  onChange={(provider) =>
                    setRoute(id, {
                      provider,
                      model:
                        provider === 'gemini' ? DEFAULT_GEMINI_MODEL : ai.settings.fallbackModel
                    })
                  }
                />
                <ModelField
                  key={`${route.provider}:${route.model}`}
                  provider={route.provider}
                  value={route.model}
                  suggestions={
                    route.provider === 'ollama'
                      ? (installed ?? [])
                      : [...new Set([DEFAULT_GEMINI_MODEL, ...geminiModels])]
                  }
                  installed={route.provider === 'ollama' ? installed : null}
                  onSave={(model) => setRoute(id, { provider: route.provider, model })}
                />
                {route.provider === 'gemini' && ai.geminiKey === 'missing' && (
                  <span className="text-[11.5px] text-amber-200/80">
                    No key yet: the fallback model answers.
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-zinc-500">
          If Gemini can&apos;t answer, the fallback model on this PC does. Nothing local is ever
          sent to Gemini instead.
        </p>
      </Card>
    </Section>
  )
}

function ProviderSwitch({
  value,
  onChange
}: {
  value: ProviderId
  onChange: (provider: ProviderId) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" className="flex rounded-full bg-white/[0.06] p-0.5">
      {(['ollama', 'gemini'] as const).map((provider) => (
        <button
          key={provider}
          type="button"
          role="radio"
          aria-checked={value === provider}
          onClick={() => value !== provider && onChange(provider)}
          className={`rounded-full px-3 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-teal-300/70 ${
            value === provider
              ? 'bg-white/[0.14] text-zinc-50'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {PROVIDER_LABEL[provider]}
        </button>
      ))}
    </div>
  )
}

/** A model name, saved when it's valid and the field loses focus or Enter is pressed. */
function ModelField({
  provider,
  value,
  suggestions,
  installed,
  onSave
}: {
  provider: ProviderId
  value: string
  suggestions: string[]
  /** Ollama's installed models, to warn about one that isn't pulled yet. */
  installed: string[] | null
  onSave: (model: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const valid = isValidModel(provider, draft)
  const listId = useId()
  const save = (): void => {
    if (valid && draft !== value) onSave(draft)
  }
  const missing = installed !== null && valid && !installed.includes(draft)

  return (
    <div className="flex min-w-0 flex-col">
      <input
        type="text"
        value={draft}
        list={listId}
        aria-label={`${PROVIDER_LABEL[provider]} model`}
        aria-invalid={!valid}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value.trim())}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
        }}
        className="w-52 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-zinc-100 outline-none focus:border-teal-300/60 aria-[invalid=true]:border-red-400/60"
      />
      <datalist id={listId}>
        {suggestions.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      {!valid && <span className="mt-1 text-[11px] text-red-300">Not a valid model name.</span>}
      {missing && (
        <span className="mt-1 text-[11px] text-amber-200/80">
          Not in Ollama yet: <span className="font-mono">ollama pull {draft}</span>
        </span>
      )}
    </div>
  )
}

function TestLine({
  test,
  testing
}: {
  test: ConnectionTest | null
  testing: boolean
}): React.JSX.Element | null {
  if (testing) return <p className="mt-3 text-[12px] text-zinc-500">Testing…</p>
  if (!test) return null
  return (
    <div className="mt-3 flex items-start gap-2 text-[12px]">
      <span
        className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${test.ok ? 'bg-emerald-400' : 'bg-red-400'}`}
      />
      <span className={test.ok ? 'text-zinc-300' : 'text-red-300'}>
        {test.ok ? test.detail : test.message}
      </span>
    </div>
  )
}
