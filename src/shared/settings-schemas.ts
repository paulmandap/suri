import { z } from 'zod'
import { isLoopbackUrl, isValidModel } from './ai-config'

// Main validates everything the Settings window sends (CLAUDE.md: Zod at every
// boundary). Main-only at runtime: the sandboxed preload can't load zod.

export const generalPatchSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535).optional(),
  hideFromCapture: z.boolean().optional(),
  safetyNet: z.boolean().optional(),
  openAtLogin: z.boolean().optional(),
  soundNeedsYou: z.boolean().optional(),
  soundFinished: z.boolean().optional(),
  recaps: z.boolean().optional()
})

export type GeneralPatch = z.infer<typeof generalPatchSchema>

export const hookActionSchema = z.enum(['install', 'uninstall'])

export const previewIdSchema = z.string().regex(/^preview-\d{1,9}$/)

export const revealTargetSchema = z.enum(['settings-file', 'last-backup', 'history-file'])

export const providerSchema = z.enum(['ollama', 'gemini'])

export const aiPatchSchema = z.strictObject({
  ollamaUrl: z.string().max(200).refine(isLoopbackUrl).optional(),
  fallbackModel: z
    .string()
    .refine((model) => isValidModel('ollama', model))
    .optional(),
  route: z
    .strictObject({
      feature: z.enum(['risk', 'recap', 'fileQa', 'digest']),
      provider: providerSchema,
      model: z.string()
    })
    .refine((route) => isValidModel(route.provider, route.model))
    .optional()
})

/** An API key as pasted: printable characters, no spaces, a sane length. */
export const geminiKeySchema = z
  .string()
  .trim()
  .min(20)
  .max(256)
  .regex(/^[\x21-\x7e]+$/)
