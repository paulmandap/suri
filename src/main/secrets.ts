import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

// The Gemini API key, saved encrypted with Windows DPAPI (CLAUDE.md: secrets
// never in plain files, logs or git). Main passes in Electron's safeStorage;
// taking it as a parameter keeps Electron out, so tests run in plain Node.

export type SecretName = 'geminiApiKey'

/** The part of Electron's safeStorage that Suri uses. */
export interface Encryptor {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export interface SecretStore {
  /** Whether Windows can encrypt, so a key can be saved at all. */
  available(): boolean
  /**
   * Whether get() returns a value. A saved key that can't be decrypted counts
   * as missing, so Settings asks for it again.
   */
  has(name: SecretName): boolean
  /**
   * The value, or null when none is saved or it can't be decrypted: DPAPI
   * opens it only for the Windows user who saved it, on the same PC.
   */
  get(name: SecretName): string | null
  /** Encrypts and saves. If that fails it throws, with a message for Settings, and writes nothing. */
  set(name: SecretName, value: string): void
  /** Does nothing when the value isn't there. Throws, with a message for Settings, if the write fails. */
  remove(name: SecretName): void
}

export const SECRETS_FILE = 'secrets.json'

// Name → base64 of the encrypted bytes. Names this version doesn't know are
// kept on every rewrite: a newer Suri may have saved them.
const fileSchema = z.record(z.string(), z.unknown())

type Entries = z.infer<typeof fileSchema>

export function createSecretStore(dir: string, encryptor: Encryptor): SecretStore {
  const file = join(dir, SECRETS_FILE)

  const get = (name: SecretName): string | null => {
    const sealed = readEntries(file)[name]
    if (typeof sealed !== 'string') return null
    try {
      return encryptor.decrypt(Buffer.from(sealed, 'base64'))
    } catch {
      return null
    }
  }

  return {
    available: () => encryptor.available(),
    has: (name) => get(name) !== null,
    get,

    set(name, value) {
      if (!encryptor.available()) {
        throw new Error("Windows secure storage isn't available, so the key wasn't saved.")
      }
      let sealed: string
      try {
        sealed = encryptor.encrypt(value).toString('base64')
      } catch {
        // No cause attached: it comes from a call that was handed the key.
        throw new Error("Windows couldn't encrypt the key, so it wasn't saved.")
      }
      writeEntries(
        file,
        { ...readEntries(file), [name]: sealed },
        "Suri couldn't write its key file, so the key wasn't saved."
      )
    },

    remove(name) {
      const entries = readEntries(file)
      if (!Object.hasOwn(entries, name)) return
      delete entries[name]
      writeEntries(file, entries, "Suri couldn't change its key file, so the key is still saved.")
    }
  }
}

/** A missing, unreadable or broken file reads as empty, and the next save replaces it. */
function readEntries(file: string): Entries {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/** Temp file + rename: a crash mid-write leaves the old file, never half a file. */
function writeEntries(file: string, entries: Entries, failure: string): void {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, JSON.stringify(entries, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, file)
  } catch (err) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // It holds encrypted bytes only, and the error below is the one that matters.
    }
    throw new Error(failure, { cause: err })
  }
}
