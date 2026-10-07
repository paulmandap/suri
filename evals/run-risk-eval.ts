import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_AI, isValidModel, type ProviderId } from '@shared/ai-config'
import { redactSecrets } from '@shared/redact'
import type { RiskLevel } from '@shared/types'
import { createGeminiProvider } from '../src/main/ai/gemini'
import { createOllamaProvider } from '../src/main/ai/ollama'
import { AIError, jsonSchemaOf, type AIProvider } from '../src/main/ai/provider'
import {
  RISK_SYSTEM,
  RISK_INPUT_VERSION,
  RISK_TIMEOUT_MS,
  cleanRiskReply,
  riskInputFrom,
  riskReplySchema,
  riskRequest,
  type RiskInput,
  type RiskReply
} from '../src/main/ai/risk'
import { hash, messageOf, pacer, retryDelay, seconds, sleep } from './common'
import {
  buildReport,
  caseFileSchema,
  combinedLevel,
  modelRunSchema,
  ruleLevels,
  score,
  type CaseResult,
  type EvalCase,
  type ModelRun
} from './scoring'

// The risk eval (plan, Phase 4). Each labelled case goes to each model with
// the app's own prompt, schema, cleaning and redaction, but straight to the
// provider with no fallback, so every score belongs to one model. It needs
// live models, so it lives here and never runs in `npm test`.
//
//   npm run eval:risk                                every planned local model that's available
//   npm run eval:risk -- --models qwen3.5:9b,gemini-3.8-flash
//   npm run eval:risk -- --limit 5                   a quick check; nothing is saved
//   npm run eval:risk -- --gemini-rpm 5              slower, for a stricter free tier
//   npm run eval:risk -- --report                    rebuild the report from saved runs, no model

/** The plan's line-up (Phase 4), plus the small qwen2.5 already on this PC. */
const PLANNED = [
  'qwen2.5:7b-instruct',
  'qwen2.5:3b-instruct',
  'qwen3.5:4b',
  'qwen3.5:9b',
  'gemma4:12b',
  'gemini-3.8-flash'
]

/** Gemini runs only when named in --models, so a key in the terminal can't spend quota by surprise. */
const LOCAL = PLANNED.filter((model) => !model.startsWith('gemini'))

const ROOT = process.cwd()
const CASES_FILE = join(ROOT, 'evals', 'risk-cases.json')
const RESULTS_DIR = join(ROOT, 'evals', 'results')
const RUNS_DIR = join(RESULTS_DIR, 'risk')
const REPORT_FILE = join(RESULTS_DIR, 'risk.md')

interface Options {
  models: string[]
  limit: number | null
  geminiRpm: number
  /** Only rebuild the report, e.g. after a rule change: saved answers meet today's rules. */
  reportOnly: boolean
}

export async function main(args: string[]): Promise<void> {
  const opts = parseArgs(args)
  const raw = readFileSync(CASES_FILE, 'utf8')
  const file = caseFileSchema.parse(JSON.parse(raw))
  const cases = opts.limit ? file.cases.slice(0, opts.limit) : file.cases
  const casesHash = hash(raw)
  const promptHash = hash(
    RISK_SYSTEM + JSON.stringify(jsonSchemaOf(riskReplySchema)) + `input v${RISK_INPUT_VERSION}`
  )
  const writeReport = (): void => {
    const runs = loadRuns()
    writeFileSync(
      REPORT_FILE,
      buildReport({ file, runs, casesHash, promptHash, planned: PLANNED }),
      'utf8'
    )
    console.log(`\nReport: evals/results/risk.md (${runs.length} models).`)
  }
  if (opts.reportOnly) return writeReport()

  const ollama = createOllamaProvider({ url: () => DEFAULT_AI.ollamaUrl })
  // Suri's saved key is encrypted for Suri alone (DPAPI), so the eval needs its own.
  const key = process.env['GEMINI_API_KEY']?.trim() || null
  const gemini = createGeminiProvider({ apiKey: () => key })

  let installed: string[] = []
  try {
    installed = await ollama.listModels()
  } catch (err) {
    console.log(`Ollama: ${messageOf(err)} Local models are skipped.`)
  }

  const rules = ruleLevels({ cwd: file.cwd, cases })
  const quick = opts.limit ? ' (a quick check: nothing is saved)' : ''
  console.log(`Risk eval: ${cases.length} cases${quick}.`)
  for (const model of opts.models) {
    const providerId: ProviderId = model.startsWith('gemini') ? 'gemini' : 'ollama'
    if (!isValidModel(providerId, model)) {
      console.log(`\nSkipped "${model}": not a valid model name.`)
      continue
    }
    if (providerId === 'ollama' && !installed.includes(model)) {
      console.log(`\nSkipped ${model}: not in Ollama. Get it with: ollama pull ${model}`)
      continue
    }
    if (providerId === 'gemini' && !key) {
      console.log(`\nSkipped ${model}: set GEMINI_API_KEY first (see evals/README.md).`)
      continue
    }
    const run = await runModel({
      provider: providerId === 'ollama' ? ollama : gemini,
      providerId,
      model,
      cases,
      cwd: file.cwd,
      casesHash,
      promptHash,
      gapMs: providerId === 'gemini' ? 60_000 / opts.geminiRpm : 0
    })
    printScore(run, rules)
    if (!opts.limit) save(run)
  }

  if (!opts.limit) writeReport()
}

async function runModel(opts: {
  provider: AIProvider
  providerId: ProviderId
  model: string
  cases: readonly EvalCase[]
  cwd: string
  casesHash: string
  promptHash: string
  gapMs: number
}): Promise<ModelRun> {
  const { provider, providerId, model, cases } = opts
  console.log(`\n${model}`)
  const ask = (input: RiskInput): Promise<RiskReply | null> =>
    askModel(provider, providerId, model, input)
  const wait = pacer(opts.gapMs)

  let coldMs: number | undefined
  if (providerId === 'ollama') {
    // The first call loads the model into memory, so it's timed on its own.
    const started = performance.now()
    await ask(riskInputFrom('Bash', { command: 'git status' }, opts.cwd, null)).catch(() => null)
    coldMs = Math.round(performance.now() - started)
    console.log(`  first call (loads the model): ${seconds(coldMs)}`)
  }

  const results: CaseResult[] = []
  for (const [i, c] of cases.entries()) {
    // The rule is never in the prompt, so the model is asked without it.
    const input = riskInputFrom(c.tool, c.input, c.cwd ?? opts.cwd, null)
    const rated = await rate(ask, input, wait)
    results.push({ id: c.id, label: c.label, ...rated })
    const said = rated.said ?? `no answer (${rated.error ?? 'unknown'})`
    const mark = rated.said === c.label ? 'ok ' : 'MISS'
    const time = rated.ms === null ? '' : ` · ${seconds(rated.ms)}`
    console.log(`  ${String(i + 1).padStart(2)}/${cases.length} ${mark} ${c.id}: ${said}${time}`)
  }
  return {
    model,
    provider: providerId,
    date: new Date().toLocaleDateString('sv-SE'),
    casesHash: opts.casesHash,
    promptHash: opts.promptHash,
    ...(coldMs === undefined ? {} : { coldMs }),
    results
  }
}

/** One case. A failure that says nothing about the model's judgement is tried again. */
async function rate(
  ask: (input: RiskInput) => Promise<RiskReply | null>,
  input: RiskInput,
  wait: () => Promise<void>
): Promise<Omit<CaseResult, 'id' | 'label'>> {
  for (let attempt = 1; ; attempt++) {
    await wait()
    const started = performance.now()
    try {
      const reply = await ask(input)
      const ms = Math.round(performance.now() - started)
      if (!reply) return { said: null, ms, error: 'empty answer' }
      return { said: reply.level, ms, summary: reply.summary, reversible: reply.reversible }
    } catch (err) {
      const delay = retryDelay(err, attempt)
      if (delay !== null && err instanceof AIError) {
        console.log(`  ${err.kind}: trying again in ${delay / 1000} s`)
        await sleep(delay)
        continue
      }
      const error = err instanceof AIError ? `${err.kind}: ${err.message}` : messageOf(err)
      return { said: null, ms: null, error }
    }
  }
}

/** The app's request, sent straight to one model. Cloud prompts are redacted like the router does. */
async function askModel(
  provider: AIProvider,
  providerId: ProviderId,
  model: string,
  input: RiskInput
): Promise<RiskReply | null> {
  const req = riskRequest(input)
  const text =
    providerId === 'ollama'
      ? req
      : {
          ...req,
          system: redactSecrets(req.system).text,
          prompt: redactSecrets(req.prompt).text
        }
  return cleanRiskReply(await provider.generateJSON({ ...text, model, timeoutMs: RISK_TIMEOUT_MS }))
}

function printScore(run: ModelRun, rules: readonly (RiskLevel | null)[]): void {
  const alone = score(run.results)
  const withRules = score(
    run.results.map((r, i) => ({ label: r.label, said: combinedLevel(rules[i] ?? null, r.said) }))
  )
  const pct = (s: typeof alone): string => `${Math.round((100 * s.correct) / s.total)}%`
  console.log(
    `  => ${pct(alone)} alone (high caught ${alone.highCaught}/${alone.highs}), ` +
      `${pct(withRules)} with the rules (high caught ${withRules.highCaught}/${withRules.highs})`
  )
}

function save(run: ModelRun): void {
  mkdirSync(RUNS_DIR, { recursive: true })
  const name = `${run.model.replace(/[^a-z0-9.-]+/gi, '-')}.json`
  writeFileSync(join(RUNS_DIR, name), JSON.stringify(run, null, 2) + '\n', 'utf8')
}

/** Every saved run: the plan's models in its order, then any others by name. */
function loadRuns(): ModelRun[] {
  if (!existsSync(RUNS_DIR)) return []
  const runs = readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => modelRunSchema.parse(JSON.parse(readFileSync(join(RUNS_DIR, name), 'utf8'))))
  const order = (model: string): number => {
    const i = PLANNED.indexOf(model)
    return i === -1 ? PLANNED.length : i
  }
  return runs.sort((a, b) => order(a.model) - order(b.model) || a.model.localeCompare(b.model))
}

function parseArgs(args: readonly string[]): Options {
  const value = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const models =
    value('models')
      ?.split(',')
      .map((model) => model.trim())
      .filter(Boolean) ?? LOCAL
  const limitText = value('limit')
  const limit = limitText === undefined ? null : Number(limitText)
  if (limit !== null && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error('--limit needs a whole number above 0.')
  }
  const geminiRpm = Number(value('gemini-rpm') ?? 10)
  if (!(geminiRpm > 0)) throw new Error('--gemini-rpm needs a number above 0.')
  return { models, limit, geminiRpm, reportOnly: args.includes('--report') }
}
