import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretStore, SECRETS_FILE, type Encryptor } from '../src/main/secrets'

// A stand-in for Electron's safeStorage: reversible, and obviously not plain text.
function encryptor(available = true): Encryptor {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(`sealed:${[...plain].reverse().join('')}`, 'utf8'),
    decrypt: (data) => {
      const text = data.toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('not ours')
      return [...text.slice('sealed:'.length)].reverse().join('')
    }
  }
}

const KEY = `AIza${'k'.repeat(35)}`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suri-secrets-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const file = (): string => join(dir, SECRETS_FILE)

describe('createSecretStore', () => {
  it('keeps a value only in encrypted form', () => {
    const store = createSecretStore(dir, encryptor())
    expect(store.has('geminiApiKey')).toBe(false)
    store.set('geminiApiKey', KEY)
    expect(store.has('geminiApiKey')).toBe(true)
    expect(store.get('geminiApiKey')).toBe(KEY)
    const onDisk = readFileSync(file(), 'utf8')
    expect(onDisk).not.toContain(KEY)
    expect(onDisk).not.toContain('k'.repeat(10))
    expect(readdirSync(dir)).toEqual([SECRETS_FILE])
  })

  it('removes a value, and does nothing when there is none', () => {
    const store = createSecretStore(dir, encryptor())
    store.remove('geminiApiKey')
    expect(existsSync(file())).toBe(false)
    store.set('geminiApiKey', KEY)
    store.remove('geminiApiKey')
    expect(store.has('geminiApiKey')).toBe(false)
    expect(store.get('geminiApiKey')).toBeNull()
  })

  it('refuses to save without encryption, and writes nothing', () => {
    const store = createSecretStore(dir, encryptor(false))
    expect(store.available()).toBe(false)
    expect(() => store.set('geminiApiKey', KEY)).toThrow("Windows secure storage isn't available")
    expect(existsSync(file())).toBe(false)
  })

  it('never puts the value in an error when encryption fails', () => {
    const broken: Encryptor = {
      available: () => true,
      encrypt: (plain) => {
        throw new Error(`cannot seal ${plain}`)
      },
      decrypt: () => ''
    }
    const store = createSecretStore(dir, broken)
    let message = ''
    try {
      store.set('geminiApiKey', KEY)
    } catch (err) {
      message = String(err) + String((err as Error).cause ?? '')
    }
    expect(message).toContain("couldn't encrypt")
    expect(message).not.toContain(KEY)
    expect(existsSync(file())).toBe(false)
  })

  it('treats a broken file as empty, and a value it cannot decrypt as missing', () => {
    writeFileSync(file(), '{ not json', 'utf8')
    const store = createSecretStore(dir, encryptor())
    expect(store.get('geminiApiKey')).toBeNull()
    store.set('geminiApiKey', KEY)
    expect(store.get('geminiApiKey')).toBe(KEY)

    // Saved by another Windows user or PC: DPAPI can't open it here.
    writeFileSync(
      file(),
      JSON.stringify({ geminiApiKey: Buffer.from('foreign').toString('base64') }),
      'utf8'
    )
    expect(store.get('geminiApiKey')).toBeNull()
    expect(store.has('geminiApiKey')).toBe(false)
  })

  it('keeps entries it does not know about', () => {
    writeFileSync(file(), JSON.stringify({ futureSecret: 'c2VhbGVk' }), 'utf8')
    const store = createSecretStore(dir, encryptor())
    store.set('geminiApiKey', KEY)
    store.remove('geminiApiKey')
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ futureSecret: 'c2VhbGVk' })
  })
})
