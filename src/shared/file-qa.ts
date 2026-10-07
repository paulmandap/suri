import type { Route } from './ai-config'

// Questions about a file (plan, Phase 7; ADR-027): what the island and main
// share about the document and the answers. Plain data only.

/** What the panel shows about the loaded file. Its text stays in main. */
export interface DocumentInfo {
  name: string
  kind: 'pdf' | 'text'
  /** PDF pages, or null for a text file. */
  pages: number | null
  chars: number
  /** The file was longer than Suri reads; only its start is used. */
  truncated: boolean
  /** Who will answer, and whether that's a cloud model (the panel says so). */
  route: Route
}

export type LoadResult = { ok: true; doc: DocumentInfo } | { ok: false; message: string }

export type AskStart = { ok: true; id: string } | { ok: false; message: string }

/** An answer arriving, piece by piece. */
export type AskEvent =
  | { type: 'chunk'; id: string; text: string }
  | {
      type: 'done'
      id: string
      model: string
      /** Set when Gemini failed first and the local model answered. */
      fellBackFrom?: string
      /** Only the parts of the file that best match the question were sent. */
      partial: boolean
    }
  | { type: 'error'; id: string; message: string }

/** What the Open dialog offers besides PDF. Any other file is read too, if it's text. */
export const TEXT_EXTENSIONS: readonly string[] = [
  'txt',
  'md',
  'markdown',
  'log',
  'csv',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'css',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'cs',
  'c',
  'h',
  'cpp',
  'hpp',
  'sh',
  'ps1',
  'bat',
  'sql'
]

/** Suri reads files up to this size, and sends no more than this to a model. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
/** The longest question the panel accepts. */
export const MAX_QUESTION_CHARS = 2000
/** The most text Copy takes in one go. */
export const MAX_COPY_CHARS = 200_000
