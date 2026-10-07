import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_AI, isValidModel, type ProviderId } from '@shared/ai-config'
import { buildTurnFacts } from '@shared/history'
import { redactSecrets } from '@shared/redact'
import { createGeminiProvider } from '../src/main/ai/gemini'
import { createOllamaProvider } from '../src/main/ai/ollama'
import { AIError, jsonSchemaOf, type AIProvider } from '../src/main/ai/provider'
import {
  RECAP_SYSTEM,
  RECAP_TIMEOUT_MS,
  cleanRecapReply,
  recapReplySchema,
  recapRequest,
  type RecapReply
} from '../src/main/ai/recap'
import type { RecapSource } from '../src/main/history'
import { hash, messageOf, pacer, retryDelay, seconds, sleep } from './common'
import {
  buildRecapReport,
  caseSource,
  recapCaseFileSchema,
  recapRunSchema,
  scoreRun,
  type RecapCase,
  type RecapResult,
  type RecapRun
} from './recap-scoring'

// The recap eval (plan, Phase 6). Each labelled turn goes to each model with
// the app's own prompt, schema and cleaning, straight to the provider with no
// fallback, so every score belongs to one model. Live models only: never part
// of `npm test`.
//
//   npm run eval:recap                                 every planned model that's available
//   npm run eval:recap -- --models qwen2.5:7b-instruct,qwen3.5:9b
//   npm run eval:recap -- --limit 3                    a quick check; nothing is saved
//   npm run eval:recap -- --report                     rebuild the report from saved runs

const PLANNED = [
  'qwen2.5:7b-instruct',
  'qwen2.5:3b-instruct',
  'qwen3.5:4b',
  'qwen3.5:9b',
  'gemma4:12b',
  'gemini-3.8-flash'
]

const ROOT = process.cwd()
const CASES_FILE = join(ROOT, 'evals', 'recap-cases.json')
const RESULTS_DIR = join(ROOT, 'evals', 'results')
const RUNS_DIR = join(RESULTS_DIR, 'recap')
const REPORT_FILE = join(RESULTS_DIR, 'recap.md')

interface Options {
  models: string[]
  limit: number | null
  geminiRpm: number
  reportOnly: boolean
}

export async function main(args: string[]): Promise<void> {
  const opts = parseArgs(args)
  const raw = readFileSync(CASES_FILE, 'utf8')
  const file = recapCaseFileSchema.parse(JSON.parse(raw))
  const cases = opts.limit ? file.cases.slice(0, opts.limit) : file.cases
  const casesHash = hash(raw)
  const promptHash = hash(RECAP_SYSTEM + JSON.stringify(jsonSchemaOf(recapReplySchema)))
  const writeReport = (): void => {
    const runs = loadRuns()
    writeFileSync(
      REPORT_FILE,
      buildRecapReport({ cases: file.cases, runs, casesHash, promptHash, planned: PLANNED }),
      'utf8'
    )
    console.log(`\nReport: evals/results/recap.md (${runs.length} models).`)
  }
  if (opts.reportOnly) return writeReport()

  const ollama = createOllamaProvider({ url: () => DEFAULT_AI.ollamaUrl })
  const key = process.env['GEMINI_API_KEY']?.trim() || null
  const gemini = createGeminiProvider({ apiKey: () => key })

  let installed: string[] = []
  try {
    installed = await ollama.listModels()
  } catch (err) {
    console.log(`Ollama: ${messageOf(err)} Local models are skipped.`)
  }

  const quick = opts.limit ? ' (a quick check: nothing is saved)' : ''
  console.log(`Recap eval: ${cases.length} turns${quick}.`)
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
      casesHash,
      promptHash,
      gapMs: providerId === 'gemini' ? 60_000 / opts.geminiRpm : 0
    })
    const s = scoreRun(cases, run)
    const pct = (n: number, of: number): string => `${Math.round((100 * n) / Math.max(1, of))}%`
    console.log(
      `  => outcome ${pct(s.outcomeRight, s.total)}, facts ${pct(s.mentioned, s.mentions)}, ` +
        `made-up claims ${s.madeUp}, too long ${s.tooLong}, no follow-up ${s.missingFollowUp}`
    )
    if (!opts.limit) save(run)
  }

  if (!opts.limit) writeReport()
}

async function runModel(opts: {
  provider: AIProvider
  providerId: ProviderId
  model: string
  cases: readonly RecapCase[]
  casesHash: string
  promptHash: string
  gapMs: number
}): Promise<RecapRun> {
  const { provider, providerId, model, cases } = opts
  console.log(`\n${model}`)
  const ask = (source: RecapSource): Promise<RecapReply | null> =>
    askModel(provider, providerId, model, source)
  const wait = pacer(opts.gapMs)

  let coldMs: number | undefined
  if (providerId === 'ollama') {
    // The first call loads the model into memory, so it's timed on its own.
    const started = performance.now()
    await ask({
      project: 'warm-up',
      prompt: 'Say hello',
      facts: buildTurnFacts([], 'C:\\work\\warm-up', 1000),
      denied: [],
      lastMessage: 'Hello!'
    }).catch(() => null)
    coldMs = Math.round(performance.now() - started)
    console.log(`  first call (loads the model): ${seconds(coldMs)}`)
  }

  const results: RecapResult[] = []
  for (const [i, c] of cases.entries()) {
    const result = await recap(ask, caseSource(c), wait)
    results.push({ id: c.id, label: c.label, ...result })
    const said = result.said ?? `no answer (${result.error ?? 'unknown'})`
    const mark = result.said === c.label ? 'ok ' : 'MISS'
    const time = result.ms === null ? '' : ` · ${seconds(result.ms)}`
    console.log(`  ${String(i + 1).padStart(2)}/${cases.length} ${mark} ${c.id}: ${said}${time}`)
    if (result.title) console.log(`        "${result.title}"`)
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

/** One turn. A failure that says nothing about the model is tried again. */
async function recap(
  ask: (source: RecapSource) => Promise<RecapReply | null>,
  source: RecapSource,
  wait: () => Promise<void>
): Promise<Omit<RecapResult, 'id' | 'label'>> {
  for (let attempt = 1; ; attempt++) {
    await wait()
    const started = performance.now()
    try {
      const reply = await ask(source)
      const ms = Math.round(performance.now() - started)
      if (!reply) return { said: null, ms, error: 'empty answer' }
      return {
        said: reply.outcome,
        ms,
        title: reply.title,
        summary: reply.summary,
        followUps: reply.followUps
      }
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
  source: RecapSource
): Promise<RecapReply | null> {
  const req = recapRequest(source)
  const text =
    providerId === 'ollama'
      ? req
      : {
          ...req,
          system: redactSecrets(req.system).text,
          prompt: redactSecrets(req.prompt).text
        }
  return cleanRecapReply(
    await provider.generateJSON({ ...text, model, timeoutMs: RECAP_TIMEOUT_MS })
  )
}

function save(run: RecapRun): void {
  mkdirSync(RUNS_DIR, { recursive: true })
  const name = `${run.model.replace(/[^a-z0-9.-]+/gi, '-')}.json`
  writeFileSync(join(RUNS_DIR, name), JSON.stringify(run, null, 2) + '\n', 'utf8')
}

/** Every saved run: the plan's models in its order, then any others by name. */
function loadRuns(): RecapRun[] {
  if (!existsSync(RUNS_DIR)) return []
  const runs = readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => recapRunSchema.parse(JSON.parse(readFileSync(join(RUNS_DIR, name), 'utf8'))))
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
      .filter(Boolean) ?? PLANNED
  const limitText = value('limit')
  const limit = limitText === undefined ? null : Number(limitText)
  if (limit !== null && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error('--limit needs a whole number above 0.')
  }
  const geminiRpm = Number(value('gemini-rpm') ?? 10)
  if (!(geminiRpm > 0)) throw new Error('--gemini-rpm needs a number above 0.')
  return { models, limit, geminiRpm, reportOnly: args.includes('--report') }
}
