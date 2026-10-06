import {
  attemptsFor,
  canFallBack,
  type AIErrorKind,
  type AiSettings,
  type Feature,
  type ProviderId,
  type Route
} from '@shared/ai-config'
import { redactSecrets } from '@shared/redact'
import {
  AIError,
  asAIError,
  type AIProvider,
  type JsonRequest,
  type ModelRequest,
  type TextRequest
} from './provider'

// Picks the model for each feature (ADR-004), lets the local model answer
// when Gemini can't, and takes secrets out of anything bound for the cloud.

export interface RoutedResult<T> {
  value: T
  /** The model that answered. */
  route: Route
  /** How long that model took. A failed attempt before it doesn't count. */
  ms: number
  /** Set when Gemini failed first and the local model answered instead. */
  fellBackFrom?: { route: Route; kind: AIErrorKind; message: string }
  /** Secrets taken out of what the answering model was sent. Always 0 for the local model. */
  redactions: number
}

export interface AIRouter {
  generateJSON<T>(feature: Feature, req: Omit<JsonRequest<T>, 'model'>): Promise<RoutedResult<T>>
  streamText(feature: Feature, req: Omit<TextRequest, 'model'>): Promise<RoutedResult<string>>
}

type Text = Pick<ModelRequest, 'prompt' | 'system'>

export function createAIRouter(opts: {
  /** Read on every call, so a change in Settings applies to the next request. */
  settings: () => AiSettings
  providers: Record<ProviderId, AIProvider>
  /** Exact values that must never reach the cloud: Suri's hook token, the Gemini key. */
  secrets: () => readonly string[]
  clock?: () => number
}): AIRouter {
  const clock = opts.clock ?? Date.now

  function textFor(route: Route, req: Text): Text & { redactions: number } {
    // Only Ollama runs on this PC. Everything else counts as the cloud, so a
    // provider added later is redacted without anyone remembering to.
    if (route.provider === 'ollama') {
      return { prompt: req.prompt, system: req.system, redactions: 0 }
    }
    const known = opts.secrets()
    const prompt = redactSecrets(req.prompt, known)
    const system = req.system === undefined ? undefined : redactSecrets(req.system, known)
    return {
      prompt: prompt.text,
      system: system?.text,
      redactions: prompt.count + (system?.count ?? 0)
    }
  }

  async function run<T>(
    feature: Feature,
    req: Text & { signal?: AbortSignal },
    call: (provider: AIProvider, model: string, text: Text) => Promise<T>,
    mayFallBack: () => boolean = () => true
  ): Promise<RoutedResult<T>> {
    const routes = attemptsFor(feature, opts.settings())
    let fellBackFrom: RoutedResult<T>['fellBackFrom']
    for (const [i, route] of routes.entries()) {
      try {
        const { redactions, ...text } = textFor(route, req)
        const started = clock()
        const value = await call(opts.providers[route.provider], route.model, text)
        return {
          value,
          route,
          ms: clock() - started,
          redactions,
          ...(fellBackFrom && { fellBackFrom })
        }
      } catch (err) {
        const error = toAIError(err, req.signal)
        const last = i === routes.length - 1
        if (last || !canFallBack(error.kind) || !mayFallBack()) throw error
        fellBackFrom ??= { route, kind: error.kind, message: error.message }
      }
    }
    // attemptsFor always returns at least one route, so this is never reached.
    throw new AIError('other', 'No model is set for this feature.')
  }

  return {
    generateJSON<T>(
      feature: Feature,
      req: Omit<JsonRequest<T>, 'model'>
    ): Promise<RoutedResult<T>> {
      return run(feature, req, (provider, model, text) =>
        provider.generateJSON({ ...req, ...text, model })
      )
    },

    streamText(feature: Feature, req: Omit<TextRequest, 'model'>): Promise<RoutedResult<string>> {
      // Once the caller has shown part of an answer, a second model would
      // start over mid-sentence, so a failure after that is final.
      let shown = false
      const forward = req.onText
      const onText =
        forward &&
        ((chunk: string): void => {
          if (chunk) shown = true
          forward(chunk)
        })
      return run(
        feature,
        req,
        (provider, model, text) => provider.streamText({ ...req, ...text, model, onText }),
        () => !shown
      )
    }
  }
}

/** Any failure as an AIError. The caller's cancel wins, so it never starts a fallback. */
function toAIError(err: unknown, signal: AbortSignal | undefined): AIError {
  if (signal?.aborted) return new AIError('aborted', 'Cancelled.')
  return asAIError(
    err,
    signal,
    new AIError('other', err instanceof Error ? err.message : String(err))
  )
}
