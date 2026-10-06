import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_AI, isLoopbackUrl, isValidModel, type AiSettings } from '@shared/ai-config'
import type { SuriSettings } from '@shared/types'

export const DEFAULT_PORT = 47821
export const SETTINGS_FILE = 'settings.json'

// PowerShell 5.1 writes a UTF-8 BOM; strip it before parsing.
const BOM = new RegExp('^' + String.fromCharCode(0xfeff))

const routeSchema = z
  .object({ provider: z.enum(['ollama', 'gemini']), model: z.string() })
  .refine((route) => isValidModel(route.provider, route.model))

// The AI fields fall back one by one too: a bad route resets that feature only.
const aiSchema = z.object({
  ollamaUrl: z.string().refine(isLoopbackUrl).optional().catch(undefined),
  fallbackModel: z
    .string()
    .refine((model) => isValidModel('ollama', model))
    .optional()
    .catch(undefined),
  routes: z
    .object({
      risk: routeSchema.optional().catch(undefined),
      recap: routeSchema.optional().catch(undefined),
      fileQa: routeSchema.optional().catch(undefined),
      digest: routeSchema.optional().catch(undefined)
    })
    .optional()
    .catch(undefined)
})

// Each field falls back on its own, so one bad value never resets the token
// (and with it every hook Paul installed). Unknown fields are kept.
const storedSchema = z.looseObject({
  port: z.number().int().min(1024).max(65535).optional().catch(undefined),
  token: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .catch(undefined),
  paused: z.boolean().optional().catch(undefined),
  hideFromCapture: z.boolean().optional().catch(undefined),
  safetyNet: z.boolean().optional().catch(undefined),
  ai: aiSchema.optional().catch(undefined)
})

type Stored = z.infer<typeof storedSchema>

/** The stored AI settings, with defaults wherever a field is missing or bad. */
function aiFrom(stored: Stored['ai']): AiSettings {
  const routes = stored?.routes
  return {
    ollamaUrl: stored?.ollamaUrl ?? DEFAULT_AI.ollamaUrl,
    fallbackModel: stored?.fallbackModel ?? DEFAULT_AI.fallbackModel,
    routes: {
      risk: routes?.risk ?? DEFAULT_AI.routes.risk,
      recap: routes?.recap ?? DEFAULT_AI.routes.recap,
      fileQa: routes?.fileQa ?? DEFAULT_AI.routes.fileQa,
      digest: routes?.digest ?? DEFAULT_AI.routes.digest
    }
  }
}

export function settingsPath(dir: string): string {
  return join(dir, SETTINGS_FILE)
}

/**
 * Reads settings.json, creating it (with a fresh random token) on first run.
 * A file that isn't a JSON object is moved aside, never silently overwritten.
 */
export function loadSettings(dir: string): SuriSettings {
  const file = settingsPath(dir)
  let stored: Stored = {}
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, 'utf8').replace(BOM, '')
      const parsed = storedSchema.safeParse(JSON.parse(raw))
      if (parsed.success) stored = parsed.data
      else moveAside(file)
    } catch {
      moveAside(file)
    }
  }
  const settings: SuriSettings = {
    port: stored.port ?? DEFAULT_PORT,
    token: stored.token ?? randomBytes(32).toString('hex'),
    paused: stored.paused ?? false,
    hideFromCapture: stored.hideFromCapture ?? true,
    safetyNet: stored.safetyNet ?? true,
    ai: aiFrom(stored.ai)
  }
  const complete =
    stored.port === settings.port &&
    stored.token === settings.token &&
    stored.paused === settings.paused &&
    stored.hideFromCapture === settings.hideFromCapture &&
    stored.safetyNet === settings.safetyNet &&
    // Same fields in the same order: anything missing or reset gets written back.
    JSON.stringify(stored.ai) === JSON.stringify(settings.ai)
  if (!complete) writeAtomic(file, { ...stored, ...settings })
  return settings
}

export function saveSettings(dir: string, settings: SuriSettings): void {
  writeAtomic(settingsPath(dir), settings)
}

/** Applies a change, saves it, and returns the new settings. */
export function updateSettings(
  dir: string,
  current: SuriSettings,
  patch: Partial<Omit<SuriSettings, 'token'>>
): SuriSettings {
  const next = { ...current, ...patch }
  saveSettings(dir, next)
  return next
}

/** Temp file + rename: a crash mid-write leaves the old file, not half a file. */
function writeAtomic(file: string, data: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
}

function moveAside(file: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    renameSync(file, `${file}.bad-${stamp}`)
  } catch {
    // Can't move it (locked?): loadSettings will overwrite it, which is the lesser evil.
  }
}
