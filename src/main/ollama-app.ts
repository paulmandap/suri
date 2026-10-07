import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// Starting Ollama when it isn't running (ADR-024, Paul's choice). Suri starts
// Ollama's own app, the same as clicking it in the Start menu, so Ollama keeps
// its tray icon and its own updates. Never a path from a page: main finds it.

/** Where Ollama's app is: the per-user default install, or next to an ollama.exe on PATH. */
export function findOllamaApp(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): string | null {
  const candidates: string[] = []
  if (env['LOCALAPPDATA']) {
    candidates.push(join(env['LOCALAPPDATA'], 'Programs', 'Ollama', 'ollama app.exe'))
  }
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(delimiter)) {
    if (dir && exists(join(dir, 'ollama.exe'))) candidates.push(join(dir, 'ollama app.exe'))
  }
  return candidates.find((path) => exists(path)) ?? null
}

export type OllamaStart =
  | { state: 'running' }
  | { state: 'started' }
  | { state: 'not-installed' }
  | { state: 'failed'; message: string }

/** Ollama's app starts its server in a second or two; a slow PC gets longer. */
export const START_WAIT_MS = 30_000

/** Makes sure Ollama answers, starting its app if needed. Never throws. */
export async function ensureOllama(opts: {
  reachable: () => Promise<boolean>
  find: () => string | null
  /** Starts the app; resolves with an error message, or null when it started. */
  launch: (app: string) => Promise<string | null>
  waitMs?: number
  everyMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<OllamaStart> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const reachable = async (): Promise<boolean> => {
    try {
      return await opts.reachable()
    } catch {
      return false
    }
  }
  if (await reachable()) return { state: 'running' }
  const app = opts.find()
  if (!app) return { state: 'not-installed' }
  let error: string | null
  try {
    error = await opts.launch(app)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  if (error) return { state: 'failed', message: `Ollama didn't start: ${error}` }
  const everyMs = opts.everyMs ?? 500
  for (let waited = 0; waited < (opts.waitMs ?? START_WAIT_MS); waited += everyMs) {
    await sleep(everyMs)
    if (await reachable()) return { state: 'started' }
  }
  return { state: 'failed', message: "Ollama's app started, but its server didn't answer in time." }
}
