import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_AI, isValidModel, type ProviderId } from '@shared/ai-config'
import { redactSecrets } from '@shared/redact'
import {
  CLOUD_BUDGET,
  FILE_QA_SYSTEM,
  FILE_QA_TIMEOUT_MS,
  LOCAL_BUDGET,
  chunkDocument,
  fileQaPrompt,
  readDocument,
  type Chunk,
  type LoadedDocument
} from '../src/main/ai/file-qa'
import { createGeminiProvider } from '../src/main/ai/gemini'
import { createOllamaProvider } from '../src/main/ai/ollama'
import { AIError, type AIProvider } from '../src/main/ai/provider'
import { hash, messageOf, pacer, retryDelay, seconds, sleep } from './common'
import {
  buildFileQaReport,
  fileQaCaseFileSchema,
  fileQaRunSchema,
  retrievalHit,
  scoreFileQaRun,
  type FileQaCase,
  type FileQaResult,
  type FileQaRun
} from './file-qa-scoring'

// The file-question eval (ADR-027). Each question goes to each model with the
// app's own reading, chunking, prompt and system message, straight to the
// provider with no fallback. Live models only: never part of `npm test`.
//
//   npm run eval:files                               every planned local model that's available
//   npm run eval:files -- --models gemini-3.8-flash  Gemini only when named
//   npm run eval:files -- --limit 3                  a quick check; nothing is saved
//   npm run eval:files -- --report                   rebuild the report from saved runs

const PLANNED = [
  'qwen2.5:7b-instruct',
  'qwen2.5:3b-instruct',
  'qwen3.5:4b',
  'qwen3.5:9b',
  'gemini-3.8-flash'
]
const LOCAL = PLANNED.filter((model) => !model.startsWith('gemini'))

const ROOT = process.cwd()
const CASES_FILE = join(ROOT, 'evals', 'file-qa-cases.json')
const DOCS_DIR = join(ROOT, 'evals', 'documents')
const RESULTS_DIR = join(ROOT, 'evals', 'results')
const RUNS_DIR = join(RESULTS_DIR, 'file-qa')
const REPORT_FILE = join(RESULTS_DIR, 'file-qa.md')

interface Loaded {
  doc: LoadedDocument
  chunks: Chunk[]
}

export async function main(args: string[]): Promise<void> {
  const opts = parseArgs(args)
  const raw = readFileSync(CASES_FILE, 'utf8')
  const file = fileQaCaseFileSchema.parse(JSON.parse(raw))
  const cases = opts.limit ? file.cases.slice(0, opts.limit) : file.cases

  // The same reading and chunking as the app.
  const docs = new Map<string, Loaded>()
  let docText = ''
  for (const [key, name] of Object.entries(file.documents)) {
    const bytes = new Uint8Array(readFileSync(join(DOCS_DIR, name)))
    const doc = await readDocument(name, bytes)
    docs.set(key, { doc, chunks: chunkDocument(doc) })
    docText += doc.text
  }
  const casesHash = hash(raw + docText)
  const promptHash = hash(FILE_QA_SYSTEM + `budget ${LOCAL_BUDGET}/${CLOUD_BUDGET}`)

  const retrieval = { hits: 0, of: 0, missed: [] as string[] }
  for (const c of file.cases) {
    const loaded = docs.get(c.doc)
    if (!c.answerable || !loaded || loaded.doc.text.length <= LOCAL_BUDGET) continue
    retrieval.of++
    if (retrievalHit(c, loaded.chunks, LOCAL_BUDGET)) retrieval.hits++
    else retrieval.missed.push(c.id)
  }
  console.log(
    `Retrieval (no model): ${retrieval.hits}/${retrieval.of} answers in the picked chunks.`
  )

  const writeReport = (): void => {
    const runs = loadRuns()
    writeFileSync(
      REPORT_FILE,
      buildFileQaReport({
        cases: file.cases,
        runs,
        retrieval,
        casesHash,
        promptHash,
        planned: PLANNED
      }),
      'utf8'
    )
    console.log(`\nReport: evals/results/file-qa.md (${runs.length} models).`)
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

  console.log(
    `File question eval: ${cases.length} questions${opts.limit ? ' (nothing saved)' : ''}.`
  )
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
    const provider = providerId === 'ollama' ? ollama : gemini
    const run = await runModel({
      provider,
      providerId,
      model,
      cases,
      docs,
      casesHash,
      promptHash,
      gapMs: providerId === 'gemini' ? 60_000 / opts.geminiRpm : 0
    })
    const byId = new Map(run.results.map((r) => [r.id, r]))
    const s = scoreFileQaRun(cases, (c) => byId.get(c.id)?.answer ?? null)
    console.log(
      `  => facts ${s.mentioned}/${s.mentions}, said "it doesn't say" ${s.saidNotInDocument}/${s.unanswerable}`
    )
    if (!opts.limit) save(run)
  }
  if (!opts.limit) writeReport()
}

async function runModel(opts: {
  provider: AIProvider
  providerId: ProviderId
  model: string
  cases: readonly FileQaCase[]
  docs: Map<string, Loaded>
  casesHash: string
  promptHash: string
  gapMs: number
}): Promise<FileQaRun> {
  const { provider, providerId, model, cases, docs } = opts
  console.log(`\n${model}`)
  const budget = providerId === 'ollama' ? LOCAL_BUDGET : CLOUD_BUDGET
  const ask = async (c: FileQaCase): Promise<string> => {
    const loaded = docs.get(c.doc)
    if (!loaded) throw new Error(`No document "${c.doc}".`)
    const { prompt } = fileQaPrompt(loaded.doc, loaded.chunks, c.question, [], budget)
    const text =
      providerId === 'ollama'
        ? { system: FILE_QA_SYSTEM, prompt }
        : { system: redactSecrets(FILE_QA_SYSTEM).text, prompt: redactSecrets(prompt).text }
    return provider.streamText({ ...text, model, timeoutMs: FILE_QA_TIMEOUT_MS })
  }
  const wait = pacer(opts.gapMs)

  let coldMs: number | undefined
  if (providerId === 'ollama') {
    const started = performance.now()
    await ask(cases[cases.length - 1]!).catch(() => null)
    coldMs = Math.round(performance.now() - started)
    console.log(`  first call (loads the model): ${seconds(coldMs)}`)
  }

  const results: FileQaResult[] = []
  for (const [i, c] of cases.entries()) {
    const result = await answer(() => ask(c), wait)
    results.push({ id: c.id, ...result })
    const time = result.ms === null ? '' : ` · ${seconds(result.ms)}`
    const said = result.answer
      ? result.answer.replace(/\s+/g, ' ').slice(0, 110)
      : `no answer (${result.error})`
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

async function answer(
  ask: () => Promise<string>,
  wait: () => Promise<void>
): Promise<Omit<FileQaResult, 'id'>> {
  for (let attempt = 1; ; attempt++) {
    await wait()
    const started = performance.now()
    try {
      const text = await ask()
      return { ms: Math.round(performance.now() - started), answer: text }
    } catch (err) {
      const delay = retryDelay(err, attempt)
      if (delay !== null && err instanceof AIError) {
        console.log(`  ${err.kind}: trying again in ${delay / 1000} s`)
        await sleep(delay)
        continue
      }
      const error = err instanceof AIError ? `${err.kind}: ${err.message}` : messageOf(err)
      return { ms: null, answer: null, error }
    }
  }
}

function save(run: FileQaRun): void {
  mkdirSync(RUNS_DIR, { recursive: true })
  const name = `${run.model.replace(/[^a-z0-9.-]+/gi, '-')}.json`
  writeFileSync(join(RUNS_DIR, name), JSON.stringify(run, null, 2) + '\n', 'utf8')
}

function loadRuns(): FileQaRun[] {
  if (!existsSync(RUNS_DIR)) return []
  const runs = readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => fileQaRunSchema.parse(JSON.parse(readFileSync(join(RUNS_DIR, name), 'utf8'))))
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
