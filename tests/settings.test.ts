import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PORT, loadSettings, settingsPath, updateSettings } from '../src/main/settings'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suri-settings-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const onDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(settingsPath(dir), 'utf8')) as Record<string, unknown>

describe('loadSettings', () => {
  it('creates settings with a random token on first run, then keeps it', () => {
    const first = loadSettings(dir)
    expect(first).toMatchObject({ port: DEFAULT_PORT, paused: false, hideFromCapture: true })
    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    expect(loadSettings(dir).token).toBe(first.token)
    expect(onDisk().token).toBe(first.token)
  })

  it('reads a file PowerShell saved with a UTF-8 BOM', () => {
    const token = 'c'.repeat(64)
    const bom = String.fromCharCode(0xfeff)
    writeFileSync(settingsPath(dir), bom + JSON.stringify({ port: 50000, token }), 'utf8')
    expect(loadSettings(dir)).toMatchObject({ port: 50000, token })
  })

  it('moves an unreadable file aside instead of overwriting it', () => {
    writeFileSync(settingsPath(dir), '{ not json', 'utf8')
    const settings = loadSettings(dir)
    expect(settings.token).toMatch(/^[0-9a-f]{64}$/)
    const aside = readdirSync(dir).filter((f) => f.startsWith('settings.json.bad-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe('{ not json')
  })

  it('fixes one bad field without losing the others or unknown ones', () => {
    const token = 'd'.repeat(64)
    writeFileSync(settingsPath(dir), JSON.stringify({ port: 'oops', token, future: 1 }), 'utf8')
    expect(loadSettings(dir)).toMatchObject({ port: DEFAULT_PORT, token })
    expect(onDisk()).toMatchObject({ port: DEFAULT_PORT, token, future: 1 })
  })

  it('saves changes atomically and leaves no temp files behind', () => {
    const settings = loadSettings(dir)
    const paused = updateSettings(dir, settings, { paused: true })
    expect(paused).toEqual({ ...settings, paused: true })
    expect(onDisk()).toMatchObject({ paused: true, token: settings.token })
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })
})

describe('safety net setting', () => {
  it('is on by default and can be switched off', () => {
    const settings = loadSettings(dir)
    expect(settings.safetyNet).toBe(true)
    expect(updateSettings(dir, settings, { safetyNet: false }).safetyNet).toBe(false)
    expect(loadSettings(dir).safetyNet).toBe(false)
  })
})
