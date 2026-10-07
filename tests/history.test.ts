import { beforeEach, describe, expect, it } from 'vitest'
import type { Digest } from '@shared/digest'
import { dayKey, type TurnView } from '@shared/history'
import type { PendingApproval } from '@shared/types'
import { openDatabase } from '../src/main/db'
import { STALE_TURN_MS, createHistory, type History } from '../src/main/history'
import { hookEvent } from './helpers'

// The fixtures' own session, prompt and folder (C:\work\demo-project).
const SESSION = 'bc2e1766-e5f7-4a96-895e-064b8542b8d3'
const START = new Date(2026, 9, 7, 9, 0).getTime()
const DAY = dayKey(START)
const TOKEN = 'f'.repeat(64)
const DAY_MS = 24 * 60 * 60_000

let now: number
let history: History
let logs: string[]
let changes: number

beforeEach(() => {
  now = START
  logs = []
  changes = 0
  history = createHistory(openDatabase(':memory:'), {
    clock: () => now,
    secrets: () => [TOKEN],
    log: (line) => logs.push(line)
  })
  history.onChange(() => changes++)
})

/** Records fixtures (or payloads) one after another, 10 s apart. */
function play(...steps: (string | Record<string, unknown>)[]): (number | null)[] {
  return steps.map((step) => {
    now += 10_000
    return history.record(hookEvent(step))
  })
}

const fullTurn = [
  'UserPromptSubmit',
  'PreToolUse.Read',
  'PostToolUse.Read',
  'PreToolUse.Bash',
  'PostToolUse.Bash',
  'PreToolUse.Edit',
  'PostToolUse.Edit',
  'Stop'
]

const onlyTurn = (): TurnView => {
  const turns = history.turns(DAY)
  expect(turns).toHaveLength(1)
  return turns[0]!
}

const bash = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: SESSION,
  cwd: 'C:\\work\\demo-project',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  ...extra
})

const approval = (detail: string): PendingApproval => ({
  id: 'approval-1',
  sessionId: SESSION,
  project: 'demo-project',
  tool: 'Bash',
  verb: 'Running',
  detail,
  risk: { level: 'high', rule: 'force-push', reason: 'Rewrites history.' },
  createdAt: now,
  expiresAt: now + 110_000
})

describe('recording a turn', () => {
  it('turns a real captured turn into one row with its facts', () => {
    const ids = play(...fullTurn)
    expect(new Set(ids).size).toBe(1)
    const turn = onlyTurn()
    expect(turn).toMatchObject({
      id: ids[0],
      sessionId: SESSION,
      project: 'demo-project',
      day: DAY,
      status: 'done',
      startedAt: START + 10_000,
      endedAt: START + 80_000,
      lastMessage: expect.stringMatching(/^Done: notes\.txt now has bread/)
    })
    expect(turn.prompt).toMatch(/^Read notes\.txt\./)
    expect(turn.facts).toEqual({
      durationMs: 70_000,
      steps: 3,
      filesChanged: [{ path: 'notes.txt', added: 1, removed: 0 }],
      moreFiles: 0,
      linesAdded: 1,
      linesRemoved: 0,
      commands: [{ command: 'echo hello-from-suri', status: 'ok' }],
      moreCommands: 0,
      reads: 1,
      searches: 0,
      web: 0,
      agents: 0,
      failed: 0
    })
    expect(turn.decisions).toEqual([])
  })

  it('tells the History window about turns, not about every step', () => {
    play('UserPromptSubmit', 'PreToolUse.Bash', 'PostToolUse.Bash')
    expect(changes).toBe(1)
    play('Stop')
    expect(changes).toBe(2)
  })

  it('ends a turn left open when the next prompt comes (Esc, then a new request)', () => {
    play('UserPromptSubmit', 'PreToolUse.Bash')
    play({ ...hookEvent('UserPromptSubmit'), prompt_id: 'second', prompt: 'Something else' })
    const [second, first] = history.turns(DAY)
    expect(first).toMatchObject({ status: 'interrupted', endedAt: START + 30_000 })
    expect(first?.facts?.commands).toEqual([{ command: 'echo hello-from-suri', status: 'stopped' }])
    expect(second).toMatchObject({ status: 'running', prompt: 'Something else' })
  })

  it('keeps one turn when Claude Code sends the same prompt twice', () => {
    play('UserPromptSubmit', 'UserPromptSubmit', 'Stop')
    expect(onlyTurn().status).toBe('done')
  })

  it('still records a turn Suri only saw the end of', () => {
    play('PostToolUse.Edit', 'Stop')
    const turn = onlyTurn()
    expect(turn.prompt).toBeUndefined()
    expect(turn.facts?.filesChanged).toEqual([{ path: 'notes.txt', added: 1, removed: 0 }])
  })

  it('marks a failed tool call, with what went wrong', () => {
    play(
      'UserPromptSubmit',
      bash('npm test', { tool_use_id: 'toolu_t1' }),
      bash('npm test', {
        hook_event_name: 'PostToolUseFailure',
        tool_use_id: 'toolu_t1',
        error: 'Exit code 1: 2 tests failed'
      }),
      'Stop'
    )
    const facts = onlyTurn().facts
    expect(facts?.commands).toEqual([{ command: 'npm test', status: 'failed' }])
    expect(facts?.failed).toBe(1)
  })

  it('without prompt ids, events join the session’s open turn', () => {
    const plain = (payload: Record<string, unknown>): Record<string, unknown> => {
      const copy = { ...payload }
      delete copy.prompt_id
      return copy
    }
    const ids = play(
      plain(hookEvent('UserPromptSubmit')),
      plain(hookEvent('PreToolUse.Bash')),
      plain(hookEvent('PostToolUse.Bash')),
      plain(hookEvent('Stop'))
    )
    expect(new Set(ids).size).toBe(1)
    expect(onlyTurn()).toMatchObject({ status: 'done', facts: { steps: 1 } })
  })

  it('closes open turns when the session ends, and records a failed turn', () => {
    play('UserPromptSubmit', 'PreToolUse.Read', 'SessionEnd')
    expect(onlyTurn()).toMatchObject({ status: 'interrupted' })
    play(
      { ...hookEvent('UserPromptSubmit'), prompt_id: 'p2' },
      {
        ...hookEvent('Stop'),
        hook_event_name: 'StopFailure',
        prompt_id: 'p2',
        error: 'API overloaded'
      }
    )
    expect(history.turns(DAY)[0]).toMatchObject({ status: 'error', error: 'API overloaded' })
  })

  it('takes secrets out before anything is stored', () => {
    play(
      {
        ...hookEvent('UserPromptSubmit'),
        prompt: `use ${TOKEN} and api_key=sk-12345678901234567890`
      },
      bash('curl -H "Authorization: Bearer abcdefghijklmnop1234" https://example.com'),
      'Stop'
    )
    const turn = onlyTurn()
    expect(turn.prompt).not.toContain(TOKEN)
    expect(turn.prompt).not.toContain('sk-1234567890')
    expect(turn.prompt).toContain('[REDACTED]')
    expect(turn.facts?.commands[0]?.command).toContain('Authorization: Bearer [REDACTED]')
  })

  it('cuts long text to a sane length', () => {
    play({ ...hookEvent('UserPromptSubmit'), prompt: 'x'.repeat(50_000) }, 'Stop')
    const prompt = onlyTurn().prompt ?? ''
    expect(prompt.length).toBeLessThanOrEqual(2000)
    expect(prompt.endsWith('…')).toBe(true)
  })

  it('leaves out payloads `npm run replay` marked', () => {
    expect(play({ ...hookEvent('UserPromptSubmit'), suri_replay: true })).toEqual([null])
    expect(history.days()).toEqual([])
  })

  it('never throws, even when the database is gone', () => {
    history.close()
    expect(play('UserPromptSubmit')).toEqual([null])
    expect(logs.join('\n')).toMatch(/recording an event failed/)
    expect(() => history.recordDecision(approval('git push'), 'allow')).not.toThrow()
  })
})

describe('decisions', () => {
  it('belong to the turn that asked, and denied ones reach the recap', () => {
    const [turnId] = play('UserPromptSubmit', 'PreToolUse.Bash')
    history.recordDecision(approval('git push --force origin main'), 'deny')
    history.recordDecision({ ...approval('echo hi'), risk: undefined }, 'allow')
    play('Stop')
    expect(onlyTurn().decisions).toEqual([
      expect.objectContaining({
        detail: 'git push --force origin main',
        outcome: 'deny',
        level: 'high'
      }),
      expect.objectContaining({ detail: 'echo hi', outcome: 'allow' })
    ])
    expect(history.decisions(DAY)).toHaveLength(2)
    expect(history.recapSource(turnId!)?.denied).toEqual(['git push --force origin main'])
  })
})

describe('recaps', () => {
  it('gives the recap writer the request, the facts and the final message', () => {
    const [turnId] = play(...fullTurn)
    const source = history.recapSource(turnId!)
    expect(source).toMatchObject({
      project: 'demo-project',
      prompt: expect.stringMatching(/^Read notes\.txt/),
      lastMessage: expect.stringMatching(/^Done:/),
      denied: [],
      facts: { steps: 3 }
    })
  })

  it('has nothing to recap for a turn with no request, steps or message', () => {
    const [turnId] = play({ ...hookEvent('Stop'), last_assistant_message: undefined })
    expect(history.recapSource(turnId!)).toBeNull()
    expect(history.recapSource(999)).toBeNull()
  })

  it('keeps the recap state, and lists the ones still waiting', () => {
    const [turnId] = play(...fullTurn)
    history.setRecap(turnId!, { state: 'pending' })
    expect(history.pendingRecaps(START)).toEqual([turnId])
    expect(history.pendingRecaps(START + DAY_MS)).toEqual([])
    const recap = {
      title: 'Add bread to the list',
      summary: 'Appended bread to notes.txt and ran an echo.',
      outcome: 'done' as const,
      followUps: [],
      model: 'qwen2.5:7b-instruct'
    }
    history.setRecap(turnId!, { state: 'done', recap })
    expect(onlyTurn()).toMatchObject({ recap, recapState: 'done' })
    expect(history.pendingRecaps(START)).toEqual([])
    history.setRecap(turnId!, { state: 'failed', note: "Can't reach Ollama." })
    expect(onlyTurn()).toMatchObject({ recapState: 'failed', recapNote: "Can't reach Ollama." })
    expect(onlyTurn().recap).toBeUndefined()
  })
})

describe('days and digests', () => {
  it('lists days with work, newest first', () => {
    play(...fullTurn)
    now += DAY_MS
    play(
      { ...hookEvent('UserPromptSubmit'), prompt_id: 'p2', cwd: 'C:\\work\\portfolio' },
      {
        ...hookEvent('Stop'),
        prompt_id: 'p2',
        cwd: 'C:\\work\\portfolio'
      }
    )
    play({ ...hookEvent('UserPromptSubmit'), prompt_id: 'p3' })
    expect(history.days()).toEqual([
      { day: dayKey(now), turns: 2, projects: 2 },
      { day: DAY, turns: 1, projects: 1 }
    ])
  })

  it('saves a digest per day, replacing the older one', () => {
    const digest: Digest = {
      day: DAY,
      headline: 'One turn in demo-project.',
      projects: [{ name: 'demo-project', done: ['Added bread'], inProgress: [] }],
      blockers: [],
      next: [],
      stats: '1 turn',
      turns: 1,
      createdAt: now
    }
    expect(history.digest(DAY)).toBeNull()
    history.saveDigest(digest)
    history.saveDigest({ ...digest, headline: 'Rewritten.' })
    expect(history.digest(DAY)).toEqual({ ...digest, headline: 'Rewritten.' })
  })
})

describe('prune', () => {
  it('drops old steps but keeps the counted facts', () => {
    play(...fullTurn)
    now += 31 * DAY_MS
    history.prune()
    expect(onlyTurn().facts?.steps).toBe(3)
    const [turnId] = [onlyTurn().id]
    // The facts were saved at Stop, so the recap still has them.
    expect(history.recapSource(turnId)?.facts.steps).toBe(3)
  })

  it('closes turns that never ended, and forgets everything after a year', () => {
    play('UserPromptSubmit', 'PreToolUse.Bash')
    now += STALE_TURN_MS + 60_000
    history.prune()
    expect(onlyTurn()).toMatchObject({ status: 'interrupted', endedAt: START + 10_000 })
    now += 366 * DAY_MS
    history.prune()
    expect(history.days()).toEqual([])
  })
})
