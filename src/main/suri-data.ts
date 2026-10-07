import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'
import type { HookTarget } from '@shared/hook-config'
import type { FinishResult } from '@shared/uninstall-ipc'
import { BOM, DEFAULT_PORT, SETTINGS_FILE } from './settings'

// Suri's own folder (%APPDATA%\Suri), as the Uninstall window sees it (ADR-031).

/** What Suri itself writes into its folder, with the copies it moves aside. */
const SURI_FILES = [SETTINGS_FILE, 'history.db', 'secrets.json']

const NO_TOKEN = '0'.repeat(64)

/**
 * The port and token Suri's hooks were installed with, read without touching
 * the file. Only used to describe the hooks: removing them finds every Suri
 * hook by its shape, whatever the port and token (ADR-013).
 */
export function savedHookTarget(dataDir: string): HookTarget {
  try {
    const text = readFileSync(join(dataDir, SETTINGS_FILE), 'utf8').replace(BOM, '')
    const stored = JSON.parse(text) as { port?: unknown; token?: unknown }
    const port =
      typeof stored.port === 'number' && Number.isInteger(stored.port) ? stored.port : DEFAULT_PORT
    const token =
      typeof stored.token === 'string' && /^[0-9a-f]{64}$/.test(stored.token)
        ? stored.token
        : NO_TOKEN
    return { port, token }
  } catch {
    return { port: DEFAULT_PORT, token: NO_TOKEN }
  }
}

/** Whether the folder holds anything of Suri's. */
export function hasSuriData(dataDir: string): boolean {
  try {
    return readdirSync(dataDir).some(isSuriFile)
  } catch {
    return false
  }
}

/**
 * Deletes Suri's data: its settings, history and saved key, by name. The
 * whole folder (Electron's caches too) goes only when it is Suri's own
 * default folder, so a wrong path can never take anything else with it.
 */
export function deleteSuriData(dataDir: string, defaultDir: string): FinishResult {
  const dir = resolve(dataDir)
  if (dir === parse(dir).root) return { ok: false, message: "That folder isn't Suri's." }
  try {
    if (!existsSync(dir)) return { ok: true }
    if (dir === resolve(defaultDir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } else {
      for (const name of readdirSync(dir).filter(isSuriFile)) {
        rmSync(join(dir, name), { force: true, maxRetries: 3, retryDelay: 200 })
      }
    }
    return { ok: true }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      message: `Some of Suri's files couldn't be deleted (${why}). Is Suri still running? Quit it from the tray and try again.`
    }
  }
}

function isSuriFile(name: string): boolean {
  return SURI_FILES.some(
    (file) => name === file || name.startsWith(`${file}.`) || name.startsWith(`${file}-`)
  )
}
