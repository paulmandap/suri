#!/usr/bin/env node
// Replays captured hook payloads into the running Suri app, so the island can
// be watched and tested without spending Claude Code usage. Payloads are the
// real Phase 0 fixtures; the few marked synthetic were never captured live.
//
//   npm run replay -- session      a full turn: read, run, edit, finish
//   npm run replay -- permission   a held permission request (approval card)
//   npm run replay -- risky        a PreToolUse the safety net must flag
//   npm run replay -- explain      a risky command no rule sees: only the AI can flag it
//   npm run replay -- error        a turn that ends in StopFailure
//   npm run replay -- multi        two sessions at once
//   npm run replay -- workday      four synthetic requests in two projects (History, digest)
//   npm run replay -- end          end every replay session
//   options: --delay <ms> (default 900)
//            --hold <ms>  give up on a held PermissionRequest after this long
//                         (default 20000), like Claude Code closing the request
//            --record     also save the replay in Suri's history, and write recaps.
//                         Without it, replays are marked and stay out of History.
//
// With SURI_DATA_DIR set, it talks to the Suri started with the same folder.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
const RECORD = args.includes('--record')
// Each run gets its own prompt ids, so a replay recorded twice makes new turns.
const RUN = Date.now().toString(36)

const dataDir = process.env.SURI_DATA_DIR
  ? resolve(process.env.SURI_DATA_DIR)
  : join(process.env.APPDATA ?? '', 'Suri')
const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8').replace(BOM, ''))

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
// A delete written in Python: the rules don't see it, so the card starts calm.
const sneaky = {
  tool_name: 'Bash',
  tool_input: {
    command: `python -c "import shutil; shutil.rmtree('C:/work')"`,
    description: 'synthetic'
  }
}

/** A synthetic request: a prompt, tool calls (Pre + Post), then Stop. */
function request(ids, n, prompt, tools, lastMessage) {
  const prompt_id = `replay-${RUN}-${n}`
  const steps = [[{ hook_event_name: 'UserPromptSubmit', prompt, prompt_id, synthetic: true }, ids]]
  tools.forEach(([tool_name, tool_input, outcome], i) => {
    const tool_use_id = `toolu_replay_${RUN}_${n}_${i}`
    const base = { tool_name, tool_input, tool_use_id, prompt_id, synthetic: true }
    steps.push([{ ...base, hook_event_name: 'PreToolUse' }, ids])
    if (outcome?.error) {
      steps.push([{ ...base, hook_event_name: 'PostToolUseFailure', error: outcome.error }, ids])
    } else {
      steps.push([{ ...base, hook_event_name: 'PostToolUse', tool_response: outcome ?? {} }, ids])
    }
  })
  steps.push([
    {
      hook_event_name: 'Stop',
      prompt_id,
      stop_hook_active: false,
      last_assistant_message: lastMessage,
      synthetic: true
    },
    ids
  ])
  return steps
}

/** An Edit's tool_response: Claude Code's structuredPatch, with this many lines in and out. */
const patch = (added, removed) => ({
  structuredPatch: [
    {
      lines: [...Array(added).fill('+ line'), ...Array(removed).fill('- line')]
    }
  ]
})

const workday = [
  ...request(
    A,
    1,
    'Add a dark mode toggle to the settings page',
    [
      ['Read', { file_path: 'C:/work/suri-demo/src/settings.tsx' }],
      ['Edit', { file_path: 'C:/work/suri-demo/src/settings.tsx' }, patch(24, 3)],
      ['Edit', { file_path: 'C:/work/suri-demo/src/theme.ts' }, patch(12, 0)],
      ['Bash', { command: 'npm test' }, { stdout: '48 passed' }]
    ],
    'Added a dark mode toggle to Settings; the choice is saved in localStorage. All 48 tests pass.'
  ),
  ...request(
    A,
    2,
    'The login test is flaky, can you fix it?',
    [
      ['Read', { file_path: 'C:/work/suri-demo/tests/login.test.ts' }],
      ['Bash', { command: 'npm test -- login' }, { error: 'Exit code 1: 1 test failed' }],
      ['Edit', { file_path: 'C:/work/suri-demo/tests/login.test.ts' }, patch(5, 2)],
      ['Bash', { command: 'npm test -- login' }, { error: 'Exit code 1: 1 test failed' }]
    ],
    'I made the wait explicit, but the login test still fails about one run in five. It looks like a race in the mock server.'
  ),
  ...request(
    B,
    3,
    'Update the README with the new deploy steps',
    [
      ['Read', { file_path: 'C:/work/portfolio/README.md' }],
      ['Edit', { file_path: 'C:/work/portfolio/README.md' }, patch(18, 6)]
    ],
    "Updated the README's deploy section with the new Vercel steps."
  ),
  ...request(
    B,
    4,
    'Deploy the site',
    [['Bash', { command: 'npm run deploy' }, { error: 'npm error Missing script: "deploy"' }]],
    "There's no deploy script in package.json, so nothing was deployed. Should I add one with the Vercel CLI, or do you deploy from the dashboard?"
  )
]

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
  explain: [
    ['UserPromptSubmit', A],
    [{ ...readFixture('PermissionRequest.Bash'), ...sneaky, synthetic: true }, A],
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
  workday,
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
  const fromFixture = typeof source === 'string' ? readFixture(source) : source
  const payload = {
    ...fromFixture,
    ...ids,
    // A fixture's own prompt id would merge every recorded replay into one turn.
    prompt_id: String(fromFixture.prompt_id ?? '').startsWith('replay-')
      ? fromFixture.prompt_id
      : `replay-${RUN}-${ids.session_id}`,
    // History leaves marked payloads out, so demos don't land in Paul's notes.
    ...(RECORD ? {} : { suri_replay: true })
  }
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
