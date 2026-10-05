import {
  mkdtempSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUBSCRIBED_EVENTS } from '@shared/hook-events'
import {
  claudeSettingsFile,
  createInstaller,
  planHookChange,
  writeHookPlan,
  type HookPlan,
  type Installer
} from '../src/main/installer'

// Every test works in a temp folder. Nothing here may touch the real ~/.claude.

const TARGET = { port: 47821, token: 'a'.repeat(64) }
/** Local time, so the backup is named ...suri-backup-20261004-231502. */
const NOW = new Date(2026, 9, 4, 23, 15, 2)
const BOM = '﻿'
const STAMP = '.suri-backup-20261004-231502'

// What PowerShell 5.1 leaves behind: a BOM and CRLF line endings.
const ORIGINAL =
  BOM +
  JSON.stringify(
    { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } },
    null,
    2
  ).replace(/\n/g, '\r\n') +
  '\r\n'

let dir: string
let file: string
const installers: Installer[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suri-installer-'))
  file = join(dir, 'settings.json')
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const installer of installers.splice(0)) installer.close()
  rmSync(dir, { recursive: true, force: true })
})

const read = (path = file): string => readFileSync(path, 'utf8')
const files = (): string[] => readdirSync(dir).sort()

async function plan(action: 'install' | 'uninstall', target = TARGET): Promise<HookPlan> {
  const result = await planHookChange(file, action, target)
  if (!result.ok) throw new Error(result.error)
  return result.plan
}

describe('claudeSettingsFile', () => {
  it('is ~/.claude/settings.json unless CLAUDE_CONFIG_DIR moves it', () => {
    const home = join('C:', 'Users', 'someone')
    expect(claudeSettingsFile({}, home)).toBe(join(home, '.claude', 'settings.json'))
    expect(claudeSettingsFile({ CLAUDE_CONFIG_DIR: '  ' }, home)).toBe(
      join(home, '.claude', 'settings.json')
    )
    const moved = join('D:', 'claude-config')
    expect(claudeSettingsFile({ CLAUDE_CONFIG_DIR: moved }, home)).toBe(
      join(moved, 'settings.json')
    )
  })
})

describe('writeHookPlan', () => {
  it('backs up the exact bytes (BOM and all) next to the file, then writes the plan', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    const install = await plan('install')
    expect(await writeHookPlan(install, NOW)).toEqual({ ok: true, backup: file + STAMP })
    expect(read()).toBe(install.after)
    expect(readFileSync(file + STAMP)).toEqual(Buffer.from(ORIGINAL, 'utf8'))
    expect(files()).toEqual(['settings.json', 'settings.json' + STAMP])
  })

  it('refuses a file that changed after the preview, and leaves it alone', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    const install = await plan('install')
    writeFileSync(file, ORIGINAL + ' ', 'utf8')
    expect(await writeHookPlan(install, NOW)).toMatchObject({ ok: false, reason: 'changed' })
    expect(read()).toBe(ORIGINAL + ' ')
    expect(files()).toEqual(['settings.json'])
  })

  it('refuses broken JSON before anything is written', async () => {
    writeFileSync(file, '{ "model": "opus",', 'utf8')
    const result = await planHookChange(file, 'install', TARGET)
    expect(result).toMatchObject({ ok: false })
    expect(read()).toBe('{ "model": "opus",')
  })

  it('creates settings.json and its folder when there are none, with no backup', async () => {
    file = join(dir, 'new-home', '.claude', 'settings.json')
    const install = await plan('install')
    expect(await writeHookPlan(install, NOW)).toEqual({ ok: true, backup: null })
    expect(Object.keys(JSON.parse(read()).hooks)).toEqual([...SUBSCRIBED_EVENTS])
  })

  it('gives back the original bytes on uninstall, keeping both same-second backups', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    await writeHookPlan(await plan('install'), NOW)
    const result = await writeHookPlan(await plan('uninstall'), NOW)
    expect(result).toEqual({ ok: true, backup: file + STAMP + '-2' })
    expect(read()).toBe(ORIGINAL)
    expect(files()).toEqual([
      'settings.json',
      'settings.json' + STAMP,
      'settings.json' + STAMP + '-2'
    ])
  })

  it('writes nothing, not even a backup, when nothing changes', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    await writeHookPlan(await plan('install'), NOW)
    const again = await plan('install')
    expect(again.changed).toBe(false)
    expect(await writeHookPlan(again, new Date(2026, 9, 5))).toEqual({ ok: true, backup: null })
    expect(files()).toHaveLength(2)
  })

  it('keeps the old file and cleans up its temp file when the rename keeps failing', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    const install = await plan('install')
    vi.spyOn(fsp, 'rename').mockRejectedValue(
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    )
    const result = await writeHookPlan(install, NOW)
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    if (!result.ok) expect(result.message).toContain(file + STAMP)
    expect(read()).toBe(ORIGINAL)
    expect(files().some((f) => f.includes('suri-tmp'))).toBe(false)
  })

  it('retries a rename that Windows refuses for a moment', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    const install = await plan('install')
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }))
      .mockImplementation(rename)
    expect(await writeHookPlan(install, NOW)).toMatchObject({ ok: true })
    expect(read()).toBe(install.after)
  })
})

describe('createInstaller', () => {
  function installer(target = (): typeof TARGET => TARGET): Installer {
    const created = createInstaller({ file, target, now: () => NOW })
    installers.push(created)
    return created
  }

  it('previews without writing, with the token masked', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    const result = await installer().preview('install')
    if (!result.ok) throw new Error(result.message)
    expect(read()).toBe(ORIGINAL)
    expect(result.preview).toMatchObject({
      action: 'install',
      changed: true,
      suriBefore: 0,
      suriAfter: SUBSCRIBED_EVENTS.length,
      otherHooks: 1,
      backupHint: `${file}.suri-backup-<date>-<time>`
    })
    const text = result.preview.lines.map((l) => (l.kind === 'gap' ? '' : l.text)).join('\n')
    expect(text).toContain('"Authorization": "Bearer ••••••••"')
    expect(text).not.toContain(TARGET.token)
  })

  it('applies only the newest preview, and only once', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    const suri = installer()
    const first = await suri.preview('install')
    const second = await suri.preview('install')
    if (!first.ok || !second.ok) throw new Error('preview failed')
    expect(await suri.apply(first.preview.id)).toMatchObject({ ok: false, reason: 'stale' })
    expect(read()).toBe(ORIGINAL)
    expect(await suri.apply(second.preview.id)).toEqual({ ok: true, backup: file + STAMP })
    expect(await suri.apply(second.preview.id)).toMatchObject({ ok: false, reason: 'stale' })
    expect(suri.status()).toMatchObject({
      inspection: { state: 'installed' },
      lastBackup: file + STAMP
    })
  })

  it('refuses a preview made before the port changed', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    let target = TARGET
    const suri = installer(() => target)
    const result = await suri.preview('install')
    if (!result.ok) throw new Error(result.message)
    target = { ...TARGET, port: 47822 }
    expect(await suri.apply(result.preview.id)).toMatchObject({ ok: false, reason: 'stale' })
    expect(read()).toBe(ORIGINAL)
  })

  it("explains that it won't touch a file it can't read", async () => {
    writeFileSync(file, '{ nope', 'utf8')
    const suri = installer()
    const result = await suri.preview('install')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/isn't valid JSON.*Fix it by hand/)
    await suri.refresh()
    expect(suri.status().inspection.state).toBe('unreadable')
  })

  it('tells listeners when the status changes', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    const suri = installer()
    const listener = vi.fn()
    suri.onChange(listener)
    await suri.refresh()
    expect(suri.status()).toMatchObject({ exists: true, inspection: { state: 'not-installed' } })
    expect(listener).toHaveBeenCalledTimes(1)
    await suri.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notices when something else edits settings.json', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    const suri = installer()
    await suri.refresh()
    suri.watch()
    const install = await plan('install')
    writeFileSync(file, install.after, 'utf8')
    await vi.waitFor(() => expect(suri.status().inspection.state).toBe('installed'), {
      timeout: 3000,
      interval: 50
    })
  })

  it('keeps the newest status when an older, slower read finishes last', async () => {
    writeFileSync(file, ORIGINAL, 'utf8')
    const suri = installer()
    const readFile = fsp.readFile.bind(fsp)
    vi.spyOn(fsp, 'readFile').mockImplementationOnce((async (path: string) => {
      const stale = await readFile(path)
      await new Promise((resolve) => setTimeout(resolve, 100))
      return stale
    }) as typeof fsp.readFile)
    const slow = suri.refresh()
    writeFileSync(file, (await plan('install')).after, 'utf8')
    await suri.refresh()
    await slow
    expect(suri.status().inspection.state).toBe('installed')
  })
})
