#!/usr/bin/env node
// Points the sandbox project's Claude Code hooks at the running Suri app. The
// Settings window installs hooks for every project (ADR-013); this is for
// trying hook changes in sandbox/ only. Reads the port and token from Suri's
// settings.json (Suri writes it on first launch).
//
//   npm run sandbox:hooks             point the sandbox at Suri
//   npm run sandbox:hooks -- --spike  point it back at the Phase 0 spike
//
// Only sandbox/.claude/settings.local.json is touched (gitignored). Its
// `permissions` block is kept as it is.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep in sync with SUBSCRIBED_EVENTS in src/shared/hook-events.ts.
const EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd'
]
const TOOL_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest'
])
// Keep in sync with TIMEOUTS in src/shared/hook-config.ts: an identical handler
// in the global and sandbox settings then runs once.
const TIMEOUT = { PermissionRequest: 120, SessionEnd: 2 }
const BOM = String.fromCharCode(0xfeff)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const spike = process.argv.includes('--spike')

let port = 47821
let token = 'spike-token'
if (!spike) {
  const settingsFile = join(process.env.APPDATA ?? '', 'Suri', 'settings.json')
  if (!existsSync(settingsFile)) {
    console.error(`No ${settingsFile} yet. Start Suri once (npm run dev), then run this again.`)
    process.exit(1)
  }
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8').replace(BOM, ''))
  port = settings.port
  token = settings.token
}

const target = join(root, 'sandbox', '.claude', 'settings.local.json')
mkdirSync(dirname(target), { recursive: true })
const current = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {}

const hook = (event) => ({
  type: 'http',
  url: `http://127.0.0.1:${port}/hooks`,
  headers: { Authorization: `Bearer ${token}` },
  timeout: TIMEOUT[event] ?? 10
})
const hooks = Object.fromEntries(
  EVENTS.map((event) => [
    event,
    [{ ...(TOOL_EVENTS.has(event) ? { matcher: '*' } : {}), hooks: [hook(event)] }]
  ])
)

writeFileSync(target, JSON.stringify({ ...current, hooks }, null, 2) + '\n')
console.log(`sandbox hooks -> http://127.0.0.1:${port}/hooks (${spike ? 'spike' : 'Suri'})`)
