import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PORT } from '../src/main/settings'
import { deleteSuriData, hasSuriData, savedHookTarget } from '../src/main/suri-data'

// Suri's folder as the Uninstall window sees it (ADR-031). Temp folders only.

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'suri-data-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const TOKEN = 'a'.repeat(64)

/** A folder laid out like %APPDATA%\Suri after some use, plus a stranger's file. */
function suriFolder(name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'Cache'), { recursive: true })
  for (const file of [
    'settings.json',
    'settings.json.bad-2026-10-05T10-00-00-000Z',
    'settings.json.before-local-model-20261007-145139',
    'history.db',
    'history.db-wal',
    'history.db-shm',
    'history.db.bad-2026-10-06',
    'secrets.json',
    'Cache/data_0',
    'notes.txt'
  ]) {
    writeFileSync(join(dir, file), 'x')
  }
  return dir
}

describe('savedHookTarget', () => {
  it('reads the port and token the hooks were installed with, BOM or not', () => {
    const dir = join(root, 'Suri')
    mkdirSync(dir)
    // PowerShell 5.1 writes a BOM first.
    const bom = String.fromCharCode(0xfeff)
    writeFileSync(join(dir, 'settings.json'), bom + JSON.stringify({ port: 47900, token: TOKEN }))
    expect(savedHookTarget(dir)).toEqual({ port: 47900, token: TOKEN })
  })

  it('falls back on the defaults for a missing or broken file, and never writes it', () => {
    const dir = join(root, 'Suri')
    mkdirSync(dir)
    expect(savedHookTarget(dir)).toEqual({ port: DEFAULT_PORT, token: '0'.repeat(64) })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ port: 'x', token: 'short' }))
    expect(savedHookTarget(dir)).toEqual({ port: DEFAULT_PORT, token: '0'.repeat(64) })
    writeFileSync(join(dir, 'settings.json'), '{ not json')
    expect(savedHookTarget(dir).port).toBe(DEFAULT_PORT)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })
})

describe('hasSuriData', () => {
  it('sees Suri’s own files only', () => {
    expect(hasSuriData(suriFolder('Suri'))).toBe(true)
    const other = join(root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'notes.txt'), 'x')
    expect(hasSuriData(other)).toBe(false)
    expect(hasSuriData(join(root, 'missing'))).toBe(false)
  })
})

describe('deleteSuriData', () => {
  it('removes Suri’s default folder whole, Electron’s caches included', () => {
    const dir = suriFolder('Suri')
    expect(deleteSuriData(dir, dir)).toEqual({ ok: true })
    expect(existsSync(dir)).toBe(false)
  })

  it('in any other folder, removes only Suri’s files by name', () => {
    const dir = suriFolder('scratch-run')
    expect(deleteSuriData(dir, join(root, 'Suri'))).toEqual({ ok: true })
    expect(readdirSync(dir).sort()).toEqual(['Cache', 'notes.txt'])
  })

  it('is fine with nothing to delete, and refuses a drive root', () => {
    expect(deleteSuriData(join(root, 'missing'), join(root, 'missing'))).toEqual({ ok: true })
    const drive = parse(root).root
    expect(deleteSuriData(drive, drive)).toMatchObject({ ok: false })
  })
})
