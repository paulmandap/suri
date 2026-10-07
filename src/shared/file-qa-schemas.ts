import { z } from 'zod'
import { MAX_COPY_CHARS, MAX_FILE_BYTES, MAX_QUESTION_CHARS } from './file-qa'

// What the island may send about files (CLAUDE.md: Zod at every boundary).
// Main-only at runtime: the sandboxed preload can't load zod, and the island
// imports only file-qa.ts.

/** A file name as dropped: a name, never a path. */
export const fileNameSchema = z
  .string()
  .min(1)
  .max(260)
  .refine((name) => !/[\\/]/.test(name), 'A file name, not a path.')

export const fileBytesSchema = z
  .custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected the file bytes.')
  .refine((bytes) => bytes.length > 0, 'That file is empty.')
  .refine((bytes) => bytes.length <= MAX_FILE_BYTES, 'Suri reads files up to 20 MB.')

export const questionSchema = z.string().trim().min(1).max(MAX_QUESTION_CHARS)

export const askIdSchema = z.string().regex(/^ask-\d{1,9}$/)

export const copyTextSchema = z.string().min(1).max(MAX_COPY_CHARS)
