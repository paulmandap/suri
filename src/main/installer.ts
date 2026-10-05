import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  inspectHooks,
  maskSecrets,
  planHookEdit,
  type HookAction,
  type HookInspection,
  type HookTarget
} from '@shared/hook-config'
import { diffLines } from '@shared/line-diff'
import type { ApplyHooksResult, PreviewResult } from '@shared/settings-ipc'

// Installs Suri's hooks into Claude Code's user settings (ADR-013), keeping
// every rule from CLAUDE.md: a BOM-tolerant parse that refuses invalid JSON, a
// merge that keeps other tools' hooks (src/shared/hook-config.ts), a diff
// shown first, a dated backup, a check that the file still matches the
// preview, an atomic write, and Paul's click (the Settings preload refuses
// any call a click didn't start). No Electron here, so tests use temp folders.

/** Claude Code's user settings. CLAUDE_CONFIG_DIR moves them, as it moves Claude Code's. */
export function claudeSettingsFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dir = env['CLAUDE_CONFIG_DIR']?.trim()
  return join(dir || join(home, '.claude'), 'settings.json')
}

export interface FileSnapshot {
  exists: boolean
  /** The raw bytes: a backup gets exactly these. */
  bytes: Buffer
  text: string | null
  /** sha256 of the bytes ('missing' without a file). Even one more space changes it. */
  fingerprint: string
}

export async function readSnapshot(file: string): Promise<FileSnapshot> {
  try {
    const bytes = await fsp.readFile(file)
    const fingerprint = createHash('sha256').update(bytes).digest('hex')
    return { exists: true, bytes, text: bytes.toString('utf8'), fingerprint }
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err
    return { exists: false, bytes: Buffer.alloc(0), text: null, fingerprint: 'missing' }
  }
}

export interface HookPlan {
  action: HookAction
  file: string
  /** The file as the preview saw it; the write is refused if it changed since. */
  fingerprint: string
  exists: boolean
  before: string | null
  after: string
  changed: boolean
}

export async function planHookChange(
  file: string,
  action: HookAction,
  target: HookTarget
): Promise<{ ok: true; plan: HookPlan } | { ok: false; error: string }> {
  const snapshot = await readSnapshot(file)
  const edit = planHookEdit(snapshot.text, action, target)
  if (!edit.ok) return edit
  const { fingerprint, exists, text } = snapshot
  return {
    ok: true,
    plan: {
      action,
      file,
      fingerprint,
      exists,
      before: text,
      after: edit.after,
      changed: edit.changed
    }
  }
}

export type WriteResult =
  { ok: true; backup: string | null } | { ok: false; reason: 'changed' | 'failed'; message: string }

/**
 * Writes a plan: refuses if the file changed since the preview, saves a dated
 * backup of the exact bytes next to it, then swaps the new text in atomically.
 * Nothing is written if the backup fails.
 */
export async function writeHookPlan(plan: HookPlan, now = new Date()): Promise<WriteResult> {
  const current = await readSnapshot(plan.file)
  if (current.fingerprint !== plan.fingerprint) {
    return {
      ok: false,
      reason: 'changed',
      message: 'settings.json changed after the preview, so Suri wrote nothing.'
    }
  }
  if (!plan.changed) return { ok: true, backup: null }
  let backup: string | null = null
  try {
    if (current.exists) backup = await writeBackup(plan.file, current.bytes, now)
    // A symlinked settings.json (a dotfiles repo) is written through, not replaced.
    const target = current.exists ? await fsp.realpath(plan.file) : plan.file
    await writeAtomic(target, plan.after)
  } catch (err) {
    const saved = backup ? ` Your backup is at ${backup}.` : ''
    return {
      ok: false,
      reason: 'failed',
      message: `Couldn't write settings.json: ${describeError(err)}.${saved}`
    }
  }
  return { ok: true, backup }
}

/** settings.json.suri-backup-20261004-231502, beside the file; never overwrites an older one. */
async function writeBackup(file: string, bytes: Buffer, now: Date): Promise<string> {
  const base = `${file}.suri-backup-${stamp(now)}`
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    try {
      await fsp.writeFile(name, bytes, { flag: 'wx' })
      return name
    } catch (err) {
      if (errorCode(err) !== 'EEXIST' || n >= 50) throw err
    }
  }
}

/** Temp file + rename: a crash mid-write leaves the old file, never half a file. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(dirname(file), { recursive: true })
  const temp = `${file}.suri-tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    const handle = await fsp.open(temp, 'wx')
    try {
      await handle.writeFile(text, 'utf8')
      // On disk before the rename makes it the real file.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(temp, file)
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Windows refuses a rename while a virus scanner or an editor holds the file; that passes quickly. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (err) {
      if (attempt >= 6 || !BUSY.has(errorCode(err))) throw err
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  return `${date}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// --- The installer as the Settings window uses it ---------------------------

export interface InstallerStatus {
  file: string
  exists: boolean
  inspection: HookInspection
  /** The newest backup written since Suri started. */
  lastBackup: string | null
}

export interface Installer {
  status(): InstallerStatus
  /** Re-reads settings.json; listeners only hear about real changes. */
  refresh(): Promise<void>
  /** Works out a change and keeps it as the one change that may be applied. */
  preview(action: HookAction): Promise<PreviewResult>
  apply(previewId: string): Promise<ApplyHooksResult>
  onChange(listener: () => void): () => void
  /** Follows edits made outside Suri (Claude Code itself, an editor). */
  watch(): void
  close(): void
}

export function createInstaller(opts: {
  file: string
  target: () => HookTarget
  now?: () => Date
}): Installer {
  const now = opts.now ?? ((): Date => new Date())
  let status: InstallerStatus = {
    file: opts.file,
    exists: false,
    inspection: inspectHooks(null, opts.target()),
    lastBackup: null
  }
  // Only the newest preview can be applied, and only once.
  let pending: { id: string; plan: HookPlan; target: HookTarget } | null = null
  let counter = 0
  const listeners = new Set<() => void>()
  let watcher: FSWatcher | null = null
  let debounce: ReturnType<typeof setTimeout> | undefined

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  // Reads can overlap (the watcher, an install); only the newest one may set the status.
  let reads = 0
  const refresh = async (): Promise<void> => {
    const read = ++reads
    let next: InstallerStatus
    try {
      const snapshot = await readSnapshot(opts.file)
      next = {
        ...status,
        exists: snapshot.exists,
        inspection: inspectHooks(snapshot.text, opts.target())
      }
    } catch (err) {
      const detail = `Suri can't open it (${describeError(err)}).`
      const inspection: HookInspection = {
        state: 'unreadable',
        detail,
        suriHooks: 0,
        otherHooks: 0,
        warnings: []
      }
      next = { ...status, exists: true, inspection }
    }
    if (read !== reads || JSON.stringify(next) === JSON.stringify(status)) return
    status = next
    emit()
  }

  return {
    status: () => status,
    refresh,

    async preview(action) {
      pending = null
      const target = opts.target()
      let planned: Awaited<ReturnType<typeof planHookChange>>
      try {
        planned = await planHookChange(opts.file, action, target)
      } catch (err) {
        return { ok: false, message: `Suri can't open ${opts.file}: ${describeError(err)}.` }
      }
      if (!planned.ok) {
        return {
          ok: false,
          message: `Suri won't change ${opts.file}. ${planned.error} Fix it by hand, then try again.`
        }
      }
      const { plan } = planned
      const diff = diffLines(plan.before ?? '', plan.after)
      const id = `preview-${++counter}`
      pending = { id, plan, target }
      const before = inspectHooks(plan.before, target)
      return {
        ok: true,
        preview: {
          id,
          action,
          changed: plan.changed,
          lines: plan.changed
            ? diff.lines.map((line) =>
                line.kind === 'gap'
                  ? line
                  : { ...line, text: maskSecrets(line.text, [target.token]) }
              )
            : [],
          added: plan.changed ? diff.added : 0,
          removed: plan.changed ? diff.removed : 0,
          suriBefore: before.suriHooks,
          suriAfter: plan.changed ? inspectHooks(plan.after, target).suriHooks : before.suriHooks,
          otherHooks: before.otherHooks,
          backupHint: plan.exists && plan.changed ? `${opts.file}.suri-backup-<date>-<time>` : null
        }
      }
    },

    async apply(previewId) {
      const held = pending
      if (!held || held.id !== previewId) {
        return {
          ok: false,
          reason: 'stale',
          message: 'That preview is out of date. Preview again.'
        }
      }
      pending = null
      const target = opts.target()
      if (target.port !== held.target.port || target.token !== held.target.token) {
        return {
          ok: false,
          reason: 'stale',
          message: "Suri's port changed after the preview. Preview again."
        }
      }
      const result = await writeHookPlan(held.plan, now())
      if (result.ok && result.backup) status = { ...status, lastBackup: result.backup }
      await refresh()
      emit()
      return result
    },

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    watch() {
      if (watcher) return
      const name = basename(opts.file)
      try {
        // The folder, not the file: an atomic write replaces the file, which ends a file watch.
        watcher = watch(dirname(opts.file), (_event, changed) => {
          if (changed && changed !== name) return
          clearTimeout(debounce)
          debounce = setTimeout(() => void refresh(), 200)
        })
        watcher.on('error', () => {
          watcher?.close()
          watcher = null
        })
      } catch {
        // No ~/.claude yet. The Settings window refreshes when it opens.
      }
    },

    close() {
      watcher?.close()
      watcher = null
      clearTimeout(debounce)
    }
  }
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? ''
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
