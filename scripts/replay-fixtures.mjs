#!/usr/bin/env node
// Replays captured hook payloads into the running Suri app, so the island can
// be watched and tested without spending Claude Code usage. Payloads are the
// real Phase 0 fixtures; the few marked synthetic were never captured live.
//
//   npm run replay -- session      a full turn: read, run, edit, finish
//   npm run replay -- permission   a held permission request (approval card)
//   npm run replay -- risky        a PreToolUse the safety net must flag
//   npm run replay -- error        a turn that ends in StopFailure
//   npm run replay -- multi        two sessions at once
//   npm run replay -- end          end every replay session
//   options: --delay <ms> (default 900)
//            --hold <ms>  give up on a held PermissionRequest after this long
//                         (default 20000), like Claude Code closing the request

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BOM = String.fromCharCode(0xfeff)
const args = process.argv.slice(2)
const scenario = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'session'
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
const DELAY = option('delay', 900)
const HOLD = option('hold', 20_000)

const settings = JSON.parse(
  readFileSync(join(process.env.APPDATA ?? '', 'Suri', 'settings.json'), 'utf8').replace(BOM, '')
)

// Forward slashes: Suri reads both separators, and they survive every shell.
const A = { session_id: 'replay-a', cwd: 'C:/work/suri-demo' }
const B = { session_id: 'replay-b', cwd: 'C:/work/portfolio' }

const turn = [
  'UserPromptSubmit',
  'PreToolUse.Read',
  'PostToolUse.Read',
  'PreToolUse.Bash',
  'PostToolUse.Bash',
  'PreToolUse.Edit',
  'PostToolUse.Edit',
  'Stop'
]
const risky = { tool_name: 'Bash', tool_input: { command: 'rm -rf /', description: 'synthetic' } }

const SCENARIOS = {
  session: turn.map((name) => [name, A]),
  permission: [
    ['UserPromptSubmit', A],
    ['PreToolUse.PowerShell', A],
    ['PermissionRequest.PowerShell', A],
    ['Stop', A]
  ],
  risky: [
    ['UserPromptSubmit', A],
    [{ ...readFixture('PreToolUse.Bash'), ...risky, synthetic: true }, A],
    [{ ...readFixture('PermissionRequest.Bash'), ...risky, synthetic: true }, A],
    ['Stop', A]
  ],
  error: [
    ['UserPromptSubmit', A],
    ['PreToolUse.Read', A],
    ['PostToolUse.Read', A],
    [{ hook_event_name: 'StopFailure', error: 'API overloaded', synthetic: true }, A]
  ],
  multi: [
    ['UserPromptSubmit', A],
    ['UserPromptSubmit', B],
    ['PreToolUse.Read', A],
    ['PreToolUse.Bash', B],
    ['PostToolUse.Read', A],
    ['PostToolUse.Bash', B],
    ['PreToolUse.Edit', A],
    ['PostToolUse.Edit', A],
    ['Stop', B]
  ],
  end: [
    [{ hook_event_name: 'SessionEnd', reason: 'other', synthetic: true }, A],
    [{ hook_event_name: 'SessionEnd', reason: 'other', synthetic: true }, B]
  ]
}

const steps = SCENARIOS[scenario]
if (!steps) {
  console.error(`Unknown scenario "${scenario}". Try: ${Object.keys(SCENARIOS).join(', ')}`)
  process.exit(1)
}

for (const [source, ids] of steps) {
  const payload = { ...(typeof source === 'string' ? readFixture(source) : source), ...ids }
  const label =
    typeof source === 'string'
      ? source
      : `${payload.hook_event_name}${source.synthetic ? ' (synthetic)' : ''}`
  const held = payload.hook_event_name === 'PermissionRequest'
  const controller = new AbortController()
  const timer = held ? setTimeout(() => controller.abort(), HOLD) : undefined
  const started = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${settings.port}/hooks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    const body = await res.text()
    const waited = held ? ` after ${((Date.now() - started) / 1000).toFixed(1)}s` : ''
    console.log(
      `${res.status}  ${ids.session_id.padEnd(9)} ${label}${waited}${body ? `  -> ${body}` : ''}`
    )
  } catch {
    console.log(
      `---  ${ids.session_id.padEnd(9)} ${label}  (no answer; gave up after ${HOLD / 1000}s)`
    )
  } finally {
    clearTimeout(timer)
  }
  await new Promise((resolve) => setTimeout(resolve, DELAY))
}

function readFixture(name) {
  return JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'hooks', `${name}.json`), 'utf8'))
}
