#!/usr/bin/env node
// Phase 0 spike: log every Claude Code HTTP hook payload and answer
// PermissionRequest with a chosen decision. Throwaway code with no
// dependencies; the real server arrives in Phase 1 (src/main/hook-server.ts).
//
//   node spike/hook-logger.mjs [--port 47821] [--token spike-token]
//                              [--decision none|allow|deny|ask] [--delay 0]
//                              [--message "text shown to Claude on deny"]
//                              [--pretool-ask <text>]  force "ask" when a tool input contains <text>
//
// --decision none answers PermissionRequest with an empty 200, which should
// make Claude Code fall back to its own prompt. That is one of the things the
// spike exists to prove.

import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port ?? 47821)
const TOKEN = args.token ?? 'spike-token'
const DECISION = args.decision ?? 'none'
const DELAY_MS = Number(args.delay ?? 0)
const MESSAGE = args.message ?? ''
const PRETOOL_ASK = args['pretool-ask'] ?? ''
const MAX_BODY = 1024 * 1024

const here = dirname(fileURLToPath(import.meta.url))
const logDir = join(here, 'logs')
const fixtureDir = join(logDir, 'fixtures')
mkdirSync(fixtureDir, { recursive: true })
const logFile = join(logDir, `hooks-${new Date().toISOString().slice(0, 10)}.jsonl`)

const server = createServer((req, res) => {
  const started = process.hrtime.bigint()
  if (req.method !== 'POST' || !req.url?.startsWith('/hooks')) {
    res.writeHead(404).end()
    return
  }

  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) {
      res.writeHead(413).end()
      req.destroy()
      return
    }
    chunks.push(chunk)
  })

  req.on('end', async () => {
    if (res.writableEnded) return
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      body = { unparsable: raw.slice(0, 500) }
    }
    const event = body.hook_event_name ?? '(none)'
    const auth = req.headers.authorization === `Bearer ${TOKEN}`

    let reply = ''
    if (event === 'PermissionRequest') reply = await decide(body)
    else if (
      event === 'PreToolUse' &&
      PRETOOL_ASK &&
      JSON.stringify(body.tool_input ?? {}).includes(PRETOOL_ASK)
    ) {
      // Safety-net experiment: force Claude Code to ask even when the tool is allowed.
      reply = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'Suri flagged this command as risky'
        }
      })
    }
    res.writeHead(200, reply ? { 'Content-Type': 'application/json' } : {})
    res.end(reply)

    const ms = Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 10) / 10
    const entry = {
      at: new Date().toISOString(),
      event,
      ms,
      auth,
      headers: {
        host: req.headers.host ?? null,
        origin: req.headers.origin ?? null,
        'user-agent': req.headers['user-agent'] ?? null,
        'content-type': req.headers['content-type'] ?? null,
        authorization: req.headers.authorization ? '(present)' : null
      },
      reply: reply || null,
      body
    }
    appendFileSync(logFile, JSON.stringify(entry) + '\n')

    // First payload of each event (and tool) becomes a fixture candidate.
    const name = safe(event) + (body.tool_name ? '.' + safe(body.tool_name) : '')
    const fixture = join(fixtureDir, `${name}.json`)
    if (!existsSync(fixture)) writeFileSync(fixture, JSON.stringify(body, null, 2) + '\n')

    console.log(
      `${entry.at.slice(11, 19)}  ${event.padEnd(20)} ${String(body.tool_name ?? '').padEnd(10)} ` +
        `auth=${auth ? 'ok ' : 'BAD'} ${ms}ms${reply ? '  -> ' + reply : ''}`
    )
  })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE')
    console.error(`Port ${PORT} is already in use. Try --port <other>.`)
  else console.error(err)
  process.exit(1)
})

// 127.0.0.1 only: nothing outside this machine can reach the spike.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Suri hook spike listening on http://127.0.0.1:${PORT}/hooks`)
  console.log(`PermissionRequest decision: ${DECISION}${DELAY_MS ? ` after ${DELAY_MS} ms` : ''}`)
  console.log(`Log: ${logFile}\n`)
})

async function decide(body) {
  if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS))
  const behavior = DECISION === 'ask' ? await askTerminal(body) : DECISION
  if (behavior !== 'allow' && behavior !== 'deny') return ''
  const decision = behavior === 'deny' && MESSAGE ? { behavior, message: MESSAGE } : { behavior }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision }
  })
}

async function askTerminal(body) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const what =
    body.tool_input?.command ?? body.tool_input?.file_path ?? JSON.stringify(body.tool_input)
  const answer = await rl.question(
    `\nAllow ${body.tool_name}: ${what} ? [y = allow / n = deny / enter = no answer] `
  )
  rl.close()
  if (answer.trim().toLowerCase() === 'y') return 'allow'
  if (answer.trim().toLowerCase() === 'n') return 'deny'
  return 'none'
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]
  }
  return out
}

function safe(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_')
}
