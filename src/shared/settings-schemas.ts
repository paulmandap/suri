import { z } from 'zod'

// Main validates everything the Settings window sends (CLAUDE.md: Zod at every
// boundary). Main-only at runtime: the sandboxed preload can't load zod.

export const generalPatchSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535).optional(),
  hideFromCapture: z.boolean().optional(),
  safetyNet: z.boolean().optional(),
  openAtLogin: z.boolean().optional()
})

export type GeneralPatch = z.infer<typeof generalPatchSchema>

export const hookActionSchema = z.enum(['install', 'uninstall'])

export const previewIdSchema = z.string().regex(/^preview-\d{1,9}$/)

export const revealTargetSchema = z.enum(['settings-file', 'last-backup'])
