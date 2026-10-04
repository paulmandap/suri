#!/usr/bin/env node
// Replays captured hook payloads into the running Suri app, so the island can
// be watched and tested without spending Claude Code usage. Payloads are the
// real Phase 0 fixtures; the few marked synthetic were never captured live.
//
//   npm run replay -- session      a full turn: read, run, edit, finish
//   npm run replay -- permission   a permission request (waiting card)
//   npm run replay -- error        a turn that ends in StopFailure
//   npm run replay -- multi        two sessions at once
//   npm run replay -- end          end every replay session
//   options: --delay <ms> (default 900)

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BOM = String.fromCharCode(0xfeff)
const args = process.argv.slice(2)
const scenario = args.find((a) => !a.startsWith('--')) ?? 'session'
const delayIndex = args.indexOf('--delay')
const DELAY = delayIndex >= 0 ? Number(args[delayIndex + 1]) : 900

const settings = JSON.parse(
  readFileSync(join(process.env.APPDATA ?? '', 'Suri', 'settings.json'), 'utf8').replace(BOM, '')
)

const A = { session_id: 'replay-a', cwd: 'C:\\work\\suri-demo' }
const B = { session_id: 'replay-b', cwd: 'C:\\work\\portfolio' }
const PAUSE = { pause: 4000 }

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

const SCENARIOS = {
  session: turn.map((name) => [name, A]),
  permission: [
    ['UserPromptSubmit', A],
    ['PreToolUse.PowerShell', A],
    ['PermissionRequest.PowerShell', A],
    PAUSE,
    ['PostToolUse.PowerShell', A],
    ['Stop', A]
  ],
  error: [
    ['UserPromptSubmit', A],
    ['PreToolUse.Read', A],
    ['PostToolUse.Read', A],
    [{ hook_event_name: 'StopFailure', error: 'API overloaded (synthetic)' }, A]
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
    [{ hook_event_name: 'SessionEnd', reason: 'other' }, A],
    [{ hook_event_name: 'SessionEnd', reason: 'other' }, B]
  ]
}

const steps = SCENARIOS[scenario]
if (!steps) {
  console.error(`Unknown scenario "${scenario}". Try: ${Object.keys(SCENARIOS).join(', ')}`)
  process.exit(1)
}

const load = (name) =>
  JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'hooks', `${name}.json`), 'utf8'))

for (const step of steps) {
  if (!Array.isArray(step)) {
    await sleep(step.pause)
    continue
  }
  const [source, ids] = step
  const payload = { ...(typeof source === 'string' ? load(source) : source), ...ids }
  const res = await fetch(`http://127.0.0.1:${settings.port}/hooks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const label = typeof source === 'string' ? source : `${source.hook_event_name} (synthetic)`
  console.log(`${String(res.status).padEnd(4)} ${ids.session_id.padEnd(9)} ${label}`)
  await sleep(DELAY)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
