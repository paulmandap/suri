import { SUBSCRIBED_EVENTS, type HookEventName } from './hook-events'
import type { HookState } from './types'

// What Suri adds to Claude Code's user settings (~/.claude/settings.json), and
// how it finds those entries again (ADR-013). Pure text in, text out, so every
// rule is unit tested; reading, backing up and writing the file is
// src/main/installer.ts. The rules follow Coucou's installer (MIT): refuse what
// can't be read, keep every other setting and hook, take out only our own.

const BOM = '﻿'

export interface HookTarget {
  port: number
  token: string
}

export type HookAction = 'install' | 'uninstall'

/** Tool events take a matcher; '*' is what the Phase 0 sandbox proved. */
const TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest'
])

// Seconds. A PermissionRequest waits for a click (Suri steps aside at 110 s).
// SessionEnd runs while Claude Code exits, so it must never hold that up. The
// same values as scripts/sandbox-hooks.mjs: Claude Code runs a handler defined
// in two settings files once, so the sandbox doesn't get every event twice.
const TIMEOUTS: Partial<Record<HookEventName, number>> = { PermissionRequest: 120, SessionEnd: 2 }
const DEFAULT_TIMEOUT = 10

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks`
}

/** Suri's matcher group for one event, exactly as it is written. */
export function suriGroup(event: HookEventName, target: HookTarget): Record<string, unknown> {
  const hook = {
    type: 'http',
    url: hookUrl(target.port),
    headers: { Authorization: `Bearer ${target.token}` },
    timeout: TIMEOUTS[event] ?? DEFAULT_TIMEOUT
  }
  return TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }
}

// Suri's hooks are recognised by their shape, with no marker field of our own:
// Claude Code validates its settings, and an unknown key is a risk Paul's
// setup doesn't need. Any port and any token count, so an old install (port
// or token changed) is replaced, never doubled.
const SURI_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/hooks$/
const SURI_AUTH = /^Bearer [0-9a-f]{64}$/

export function isSuriHook(hook: unknown): boolean {
  if (!isRecord(hook) || hook['type'] !== 'http') return false
  if (typeof hook['url'] !== 'string' || !SURI_URL.test(hook['url'])) return false
  const headers = hook['headers']
  if (!isRecord(headers)) return false
  const auth = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')
  return typeof auth?.[1] === 'string' && SURI_AUTH.test(auth[1])
}

// --- Reading and writing the JSON text --------------------------------------

/** How the file is laid out, so a rewrite changes only what it must. */
export interface JsonStyle {
  indent: string
  eol: '\n' | '\r\n'
  bom: boolean
  /** Whitespace around the JSON, kept as it was (usually none before, one newline after). */
  leading: string
  trailing: string
}

const DEFAULT_STYLE: JsonStyle = {
  indent: '  ',
  eol: '\n',
  bom: false,
  leading: '',
  trailing: '\n'
}

export type ParsedSettings =
  { ok: true; data: Record<string, unknown>; style: JsonStyle } | { ok: false; error: string }

/**
 * Reads settings.json text; null means there is no file yet. A BOM (PowerShell
 * 5.1 adds one) and an empty file are fine. Anything that isn't a JSON object
 * is refused: not knowing what's in the file is not the same as it being empty.
 */
export function parseSettings(text: string | null): ParsedSettings {
  if (text === null) return { ok: true, data: {}, style: DEFAULT_STYLE }
  const bom = text.startsWith(BOM)
  const body = bom ? text.slice(1) : text
  if (body.trim() === '') return { ok: true, data: {}, style: { ...DEFAULT_STYLE, bom } }
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch (err) {
    return { ok: false, error: `It isn't valid JSON (${(err as Error).message}).` }
  }
  if (!isRecord(data)) return { ok: false, error: "It's JSON, but not an object ({ … })." }
  return { ok: true, data, style: detectStyle(body, bom) }
}

function detectStyle(body: string, bom: boolean): JsonStyle {
  // JSON.parse accepted it, so anything around the value is plain JSON whitespace.
  const start = body.length - body.trimStart().length
  return {
    // The first indented line inside the JSON (not the whitespace before it).
    indent: /\n([ \t]+)\S/.exec(body.slice(start))?.[1] ?? DEFAULT_STYLE.indent,
    eol: body.includes('\r\n') ? '\r\n' : '\n',
    bom,
    leading: body.slice(0, start),
    trailing: body.slice(body.trimEnd().length)
  }
}

/** JSON keeps key order; indent, line endings, BOM and surrounding whitespace follow the old file. */
export function formatSettings(data: Record<string, unknown>, style: JsonStyle): string {
  let text = JSON.stringify(data, null, style.indent)
  if (style.eol === '\r\n') text = text.replace(/\n/g, '\r\n')
  return (style.bom ? BOM : '') + style.leading + text + style.trailing
}

// --- Merging ----------------------------------------------------------------

type Edited = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

/** Takes Suri's hooks out wherever they are. Everything else keeps its place. */
function stripSuri(hooks: Record<string, unknown>): {
  hooks: Record<string, unknown>
  removed: number
} {
  let removed = 0
  const entries: [string, unknown][] = []
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      entries.push([event, groups])
      continue
    }
    let touched = false
    const kept: unknown[] = []
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) {
        kept.push(group)
        continue
      }
      const others = group['hooks'].filter((hook) => !isSuriHook(hook))
      if (others.length === group['hooks'].length) {
        kept.push(group)
        continue
      }
      touched = true
      removed += group['hooks'].length - others.length
      // Another tool's hook shares this group: keep the group for it.
      if (others.length > 0) kept.push({ ...group, hooks: others })
    }
    if (!touched) entries.push([event, groups])
    else if (kept.length > 0) entries.push([event, kept])
    // else: the event held only Suri's hooks, so the key goes too.
  }
  // fromEntries, not assignment: a key named __proto__ stays a plain key.
  return { hooks: Object.fromEntries(entries), removed }
}

/** Replaces any old Suri hooks with one fresh group per event, appended after the others. */
export function addSuriHooks(data: Record<string, unknown>, target: HookTarget): Edited {
  const current = data['hooks']
  if (current !== undefined && !isRecord(current)) return { ok: false, error: NOT_AN_OBJECT }
  const entries = Object.entries(stripSuri(current ?? {}).hooks)
  for (const event of SUBSCRIBED_EVENTS) {
    const group = suriGroup(event, target)
    const index = entries.findIndex(([name]) => name === event)
    if (index === -1) {
      entries.push([event, [group]])
      continue
    }
    const groups = entries[index][1]
    if (!Array.isArray(groups)) return { ok: false, error: notAList(event) }
    entries[index] = [event, [...groups, group]]
  }
  return { ok: true, data: { ...data, hooks: Object.fromEntries(entries) } }
}

/** Removes Suri's hooks only. A `hooks` block left empty by that goes too. */
export function removeSuriHooks(data: Record<string, unknown>): Edited {
  const current = data['hooks']
  if (current === undefined) return { ok: true, data }
  if (!isRecord(current)) return { ok: false, error: NOT_AN_OBJECT }
  const { hooks, removed } = stripSuri(current)
  if (removed === 0) return { ok: true, data }
  if (Object.keys(hooks).length > 0) return { ok: true, data: { ...data, hooks } }
  return { ok: true, data: Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'hooks')) }
}

const NOT_AN_OBJECT = '"hooks" in it isn\'t an object.'
const notAList = (event: string): string => `"hooks.${event}" in it isn't a list.`

export type PlannedEdit =
  { ok: true; after: string; changed: boolean } | { ok: false; error: string }

/**
 * The whole change as text: what settings.json would hold after an install or
 * an uninstall. Installing over a correct install changes nothing.
 */
export function planHookEdit(
  before: string | null,
  action: HookAction,
  target: HookTarget
): PlannedEdit {
  const parsed = parseSettings(before)
  if (!parsed.ok) return parsed
  const unchanged: PlannedEdit = { ok: true, after: before ?? '', changed: false }
  if (action === 'install' && inspectHooks(before, target).state === 'installed') return unchanged
  const edited =
    action === 'install' ? addSuriHooks(parsed.data, target) : removeSuriHooks(parsed.data)
  if (!edited.ok) return edited
  if (edited.data === parsed.data) return unchanged
  const after = formatSettings(edited.data, parsed.style)
  return { ok: true, after, changed: after !== before }
}

// --- Status -----------------------------------------------------------------

export interface HookInspection {
  state: HookState
  /** Why the file can't be used (unreadable) or why the hooks need an update (outdated). */
  detail?: string
  /** Suri's hooks found in the file. */
  suriHooks: number
  /** Other tools' hooks. Suri never changes them. */
  otherHooks: number
  /** Settings in the same file that would keep Suri's hooks from running. */
  warnings: string[]
}

/** Is Suri installed, and installed exactly as this copy of Suri would install it? */
export function inspectHooks(text: string | null, target: HookTarget): HookInspection {
  const parsed = parseSettings(text)
  if (!parsed.ok) return unreadable(parsed.error)
  const hooks = parsed.data['hooks']
  if (hooks !== undefined && !isRecord(hooks)) return unreadable(NOT_AN_OBJECT)
  const events = hooks ?? {}

  const found: { event: string; group: Record<string, unknown>; hook: unknown }[] = []
  let otherHooks = 0
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      if ((SUBSCRIBED_EVENTS as readonly string[]).includes(event)) {
        return unreadable(notAList(event))
      }
      continue
    }
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) continue
      for (const hook of group['hooks']) {
        if (isSuriHook(hook)) found.push({ event, group, hook })
        else otherHooks++
      }
    }
  }

  const base = { suriHooks: found.length, otherHooks, warnings: warningsFor(parsed.data, target) }
  if (found.length === 0) return { state: 'not-installed', ...base }

  const exact = SUBSCRIBED_EVENTS.every((event) => {
    const mine = found.filter((f) => f.event === event)
    return mine.length === 1 && deepEqual(mine[0].group, suriGroup(event, target))
  })
  if (exact && found.length === SUBSCRIBED_EVENTS.length) return { state: 'installed', ...base }
  return { state: 'outdated', detail: whyOutdated(found, target), ...base }
}

function whyOutdated(found: { event: string; hook: unknown }[], target: HookTarget): string {
  const ports = new Set(
    found.map((f) => Number(/:(\d+)\/hooks$/.exec(String((f.hook as { url: unknown }).url))?.[1]))
  )
  if (!ports.has(target.port) || ports.size > 1) {
    const old = [...ports].filter((p) => p !== target.port).join(', ')
    return `They send to port ${old}, but Suri now listens on ${target.port}.`
  }
  const tokenOk = found.every((f) =>
    JSON.stringify((f.hook as { headers: unknown }).headers).includes(target.token)
  )
  if (!tokenOk) return "Their token doesn't match this copy of Suri."
  const missing = SUBSCRIBED_EVENTS.filter((event) => !found.some((f) => f.event === event))
  if (missing.length > 0) return `Missing: ${missing.join(', ')}.`
  return 'They differ from what this version of Suri installs.'
}

function warningsFor(data: Record<string, unknown>, target: HookTarget): string[] {
  const warnings: string[] = []
  if (data['disableAllHooks'] === true) {
    warnings.push('"disableAllHooks" is on in this file, so Claude Code runs no hooks at all.')
  }
  const allowed = data['allowedHttpHookUrls']
  if (Array.isArray(allowed) && !allowed.some((p) => matchesUrlPattern(p, hookUrl(target.port)))) {
    warnings.push(
      `"allowedHttpHookUrls" doesn't include ${hookUrl(target.port)}, so Claude Code will skip Suri's hooks.`
    )
  }
  return warnings
}

/** An allowedHttpHookUrls entry: `*` matches anything, the rest is literal. */
function matchesUrlPattern(pattern: unknown, url: string): boolean {
  if (typeof pattern !== 'string') return false
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(url)
}

function unreadable(detail: string): HookInspection {
  return { state: 'unreadable', detail, suriHooks: 0, otherHooks: 0, warnings: [] }
}

// --- Showing the change -----------------------------------------------------

const MASK = '••••••••'
/** Keys whose values are secrets: API keys in "env", other tools' Authorization headers… */
const SECRET_KEY = /token|secret|passw|api[-_]?key|credential|authorization|cookie|private[-_]?key/i
/** One `"key": "value"` line of pretty-printed JSON. */
const STRING_PAIR = /^(\s*"((?:[^"\\]|\\.)*)"\s*:\s*")((?:[^"\\]|\\.)*)(".*)$/

/**
 * Hides secrets in a line of settings.json before the Settings window shows
 * it: Suri's own token, and the value of any key that looks like a secret.
 * The renderer never sees a secret (CLAUDE.md).
 */
export function maskSecrets(line: string, secrets: readonly string[]): string {
  let out = line
  for (const secret of secrets) if (secret) out = out.split(secret).join(MASK)
  const pair = STRING_PAIR.exec(out)
  if (!pair || !SECRET_KEY.test(pair[2]) || pair[3].includes(MASK)) return out
  const scheme = /^(?:Bearer|Basic|Token)\s+/i.exec(pair[3])?.[0] ?? ''
  return `${pair[1]}${scheme}${MASK}${pair[4]}`
}

// --- Helpers ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Same JSON value, ignoring key order. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    )
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
  )
}
