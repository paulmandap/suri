// Which model answers which feature (ADR-004, ADR-015). Plain data and pure
// decisions, shared by main and the Settings window, so no Zod here.

export type ProviderId = 'ollama' | 'gemini'

/** The AI features. Each one is routed to a provider and model in Settings. */
export type Feature = 'risk' | 'recap' | 'fileQa' | 'digest'

export interface Route {
  provider: ProviderId
  model: string
}

export interface AiSettings {
  /** Ollama on this PC. */
  ollamaUrl: string
  /** The local model that answers when Gemini can't (rate limit, offline, no key). */
  fallbackModel: string
  routes: Record<Feature, Route>
}

export const FEATURES: readonly { id: Feature; label: string; built: boolean }[] = [
  { id: 'risk', label: 'Risk explainer', built: false },
  { id: 'recap', label: 'Session recap', built: false },
  { id: 'fileQa', label: 'Questions about a file', built: false },
  { id: 'digest', label: 'Daily digest', built: false }
]

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
/** Fits the RTX 3050's 8 GB (plan, "Local models"); the Phase 4 eval may change it. */
export const DEFAULT_LOCAL_MODEL = 'qwen3.5:9b'
/** Free of charge on the Gemini free tier (checked 2026-10-05). */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'

// Frequent and sensitive features stay local; the rest use Gemini (ADR-004).
export const DEFAULT_AI: AiSettings = {
  ollamaUrl: DEFAULT_OLLAMA_URL,
  fallbackModel: DEFAULT_LOCAL_MODEL,
  routes: {
    risk: { provider: 'ollama', model: DEFAULT_LOCAL_MODEL },
    recap: { provider: 'ollama', model: DEFAULT_LOCAL_MODEL },
    fileQa: { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
    digest: { provider: 'gemini', model: DEFAULT_GEMINI_MODEL }
  }
}

/** Ollama names, e.g. `qwen3.5:9b` or `hf.co/user/repo:Q4_K_M`. */
const OLLAMA_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/
/** Gemini ids, e.g. `gemini-3.8-flash`. They end up in a URL path, so nothing else. */
const GEMINI_MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/

export function isValidModel(provider: ProviderId, model: string): boolean {
  return (provider === 'ollama' ? OLLAMA_MODEL : GEMINI_MODEL).test(model)
}

/**
 * Ollama must run on this PC: "local" is the privacy promise, and redaction
 * only guards the cloud path. http(s), a loopback host, no path or login.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.username === '' &&
    parsed.password === ''
  )
}

/** Why a model call failed, in terms the router and the Settings window act on. */
export type AIErrorKind =
  | 'offline'
  | 'rate-limit'
  | 'auth'
  | 'no-key'
  | 'not-found'
  | 'timeout'
  | 'aborted'
  | 'bad-output'
  | 'unavailable'
  | 'other'

/**
 * The models to try for a feature, in order. A Gemini route gets the local
 * model behind it; a local route never falls back to the cloud.
 */
export function attemptsFor(feature: Feature, ai: AiSettings): Route[] {
  const route = ai.routes[feature]
  if (route.provider === 'ollama') return [route]
  return [route, { provider: 'ollama', model: ai.fallbackModel }]
}

/** If Gemini couldn't answer, for any reason but a cancel, the local model tries. */
export function canFallBack(kind: AIErrorKind): boolean {
  return kind !== 'aborted'
}

/** What "Test connection" shows. */
export type ConnectionTest =
  { ok: true; detail: string; models: string[] } | { ok: false; kind: AIErrorKind; message: string }

export interface AiPatch {
  ollamaUrl?: string
  fallbackModel?: string
  route?: { feature: Feature; provider: ProviderId; model: string }
}

/** Applies a (validated) change from Settings. */
export function applyAiPatch(ai: AiSettings, patch: AiPatch): AiSettings {
  return {
    ollamaUrl: patch.ollamaUrl ?? ai.ollamaUrl,
    fallbackModel: patch.fallbackModel ?? ai.fallbackModel,
    routes: patch.route
      ? {
          ...ai.routes,
          [patch.route.feature]: { provider: patch.route.provider, model: patch.route.model }
        }
      : ai.routes
  }
}
