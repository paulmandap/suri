import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_AI, isValidModel, type ProviderId } from '@shared/ai-config'
import { digestFromReply, plainDigest, type Digest, type DigestFacts } from '@shared/digest'
import { redactSecrets } from '@shared/redact'
import {
  DIGEST_SYSTEM,
  DIGEST_TIMEOUT_MS,
  digestPrompt,
  digestReplySchema
} from '../src/main/ai/digest'
import { createGeminiProvider } from '../src/main/ai/gemini'
import { createOllamaProvider } from '../src/main/ai/ollama'
import { AIError, jsonSchemaOf, type AIProvider } from '../src/main/ai/provider'
import { hash, messageOf, pacer, retryDelay, seconds, sleep } from './common'
import {
  buildDigestReport,
  caseFacts,
  digestCaseFileSchema,
  digestRunSchema,
  scoreDigestRun,
  type DigestCase,
  type DigestResult,
  type DigestRun
} from './digest-scoring'

// The digest eval (ADR-026). Each day's facts go to each model with the app's
// own prompt and schema, straight to the provider with no fallback, and the
// reply is held to the facts with digestFromReply, as the app does. Live
// models only: never part of `npm test`.
//
//   npm run eval:digest                              every planned local model that's available
//   npm run eval:digest -- --models gemini-3.8-flash Gemini only when named
//   npm run eval:digest -- --limit 2                 a quick check; nothing is saved
//   npm run eval:digest -- --report                  rebuild the report from saved runs

const PLANNED = [
  'qwen2.5:7b-instruct',
  'qwen2.5:3b-instruct',
  'qwen3.5:4b',
  'qwen3.5:9b',
  'gemini-3.8-flash'
]
/** Gemini runs only when named in --models, so a key in the terminal can't spend quota by surprise. */
const LOCAL = PLANNED.filter((model) => !model.startsWith('gemini'))

const ROOT = process.cwd()
const CASES_FILE = join(ROOT, 'evals', 'digest-cases.json')
const RESULTS_DIR = join(ROOT, 'evals', 'results')
const RUNS_DIR = join(RESULTS_DIR, 'digest')
const REPORT_FILE = join(RESULTS_DIR, 'digest.md')
/** A fixed time for every digest, so saved runs don't differ by the clock alone. */
const WRITTEN_AT = 0

export async function main(args: string[]): Promise<void> {
  const opts = parseArgs(args)
  const raw = readFileSync(CASES_FILE, 'utf8')
  const file = digestCaseFileSchema.parse(JSON.parse(raw))
  const cases = opts.limit ? file.cases.slice(0, opts.limit) : file.cases
  const casesHash = hash(raw)
  const promptHash = hash(DIGEST_SYSTEM + JSON.stringify(jsonSchemaOf(digestReplySchema)))
  const plain = (c: DigestCase): Digest => plainDigest(caseFacts(c), WRITTEN_AT)
  const writeReport = (): void => {
    const runs = loadRuns()
    writeFileSync(
      REPORT_FILE,
      buildDigestReport({
        cases: file.cases,
        runs,
        plain,
        casesHash,
        promptHash,
        planned: PLANNED
      }),
      'utf8'
    )
    console.log(`\nReport: evals/results/digest.md (${runs.length} models).`)
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
  console.log(`Digest eval: ${cases.length} days${quick}.`)
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
    const byId = new Map(run.results.map((r) => [r.id, r]))
    const s = scoreDigestRun(cases, (c) => byId.get(c.id)?.digest ?? null)
    console.log(
      `  => placed ${s.placed}/${s.items}, claimed done ${s.claimedDone}, missing ${s.missing}, ` +
        `blockers ${s.blockers}/${s.blockersWanted}, next ${s.next}/${s.nextWanted}`
    )
    if (!opts.limit) save(run)
  }

  if (!opts.limit) writeReport()
}

async function runModel(opts: {
  provider: AIProvider
  providerId: ProviderId
  model: string
  cases: readonly DigestCase[]
  casesHash: string
  promptHash: string
  gapMs: number
}): Promise<DigestRun> {
  const { provider, providerId, model, cases } = opts
  console.log(`\n${model}`)
  const ask = (facts: DigestFacts): Promise<Digest> => askModel(provider, providerId, model, facts)
  const wait = pacer(opts.gapMs)

  let coldMs: number | undefined
  if (providerId === 'ollama') {
    const started = performance.now()
    await ask(caseFacts(cases[cases.length - 1]!)).catch(() => null)
    coldMs = Math.round(performance.now() - started)
    console.log(`  first call (loads the model): ${seconds(coldMs)}`)
  }

  const results: DigestResult[] = []
  for (const [i, c] of cases.entries()) {
    const result = await write(ask, caseFacts(c), wait)
    results.push({ id: c.id, ...result })
    const time = result.ms === null ? '' : ` · ${seconds(result.ms)}`
    const said = result.digest ? `"${result.digest.headline}"` : `no answer (${result.error})`
    console.log(`  ${String(i + 1).padStart(2)}/${cases.length} ${c.id}${time}\n        ${said}`)
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

/** One day. A failure that says nothing about the model is tried again. */
async function write(
  ask: (facts: DigestFacts) => Promise<Digest>,
  facts: DigestFacts,
  wait: () => Promise<void>
): Promise<Omit<DigestResult, 'id'>> {
  for (let attempt = 1; ; attempt++) {
    await wait()
    const started = performance.now()
    try {
      const digest = await ask(facts)
      return { ms: Math.round(performance.now() - started), digest }
    } catch (err) {
      const delay = retryDelay(err, attempt)
      if (delay !== null && err instanceof AIError) {
        console.log(`  ${err.kind}: trying again in ${delay / 1000} s`)
        await sleep(delay)
        continue
      }
      const error = err instanceof AIError ? `${err.kind}: ${err.message}` : messageOf(err)
      return { ms: null, digest: null, error }
    }
  }
}

/** The app's request, sent straight to one model, then held to the facts as the app does. */
async function askModel(
  provider: AIProvider,
  providerId: ProviderId,
  model: string,
  facts: DigestFacts
): Promise<Digest> {
  const prompt = digestPrompt(facts)
  const text =
    providerId === 'ollama'
      ? { system: DIGEST_SYSTEM, prompt }
      : { system: redactSecrets(DIGEST_SYSTEM).text, prompt: redactSecrets(prompt).text }
  const reply = await provider.generateJSON({
    ...text,
    schema: digestReplySchema,
    model,
    timeoutMs: DIGEST_TIMEOUT_MS
  })
  return digestFromReply(facts, reply, { model }, WRITTEN_AT)
}

function save(run: DigestRun): void {
  mkdirSync(RUNS_DIR, { recursive: true })
  const name = `${run.model.replace(/[^a-z0-9.-]+/gi, '-')}.json`
  writeFileSync(join(RUNS_DIR, name), JSON.stringify(run, null, 2) + '\n', 'utf8')
}

function loadRuns(): DigestRun[] {
  if (!existsSync(RUNS_DIR)) return []
  const runs = readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => digestRunSchema.parse(JSON.parse(readFileSync(join(RUNS_DIR, name), 'utf8'))))
  const order = (model: string): number => {
    const i = PLANNED.indexOf(model)
    return i === -1 ? PLANNED.length : i
  }
  return runs.sort((a, b) => order(a.model) - order(b.model) || a.model.localeCompare(b.model))
}

function parseArgs(args: readonly string[]): {
  models: string[]
  limit: number | null
  geminiRpm: number
  reportOnly: boolean
} {
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
