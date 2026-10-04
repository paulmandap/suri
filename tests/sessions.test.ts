import { describe, expect, it } from 'vitest'
import { createSessionsState, pruneSessions, reduceSessions, sortSessions } from '@shared/sessions'
import type { SessionsState } from '@shared/types'
import { hookEvent } from './helpers'

const ID = { session_id: 'session-1', cwd: 'C:\\work\\demo-project' }

/** Replays fixtures (or payloads) one after another, 100 ms apart. */
function replay(
  steps: (string | Record<string, unknown>)[],
  start = createSessionsState()
): {
  state: SessionsState
  now: number
} {
  let state = start
  let now = 1_000
  for (const step of steps) {
    now += 100
    state = reduceSessions(state, hookEvent(step, ID), now)
  }
  return { state, now }
}

describe('reduceSessions with the real Phase 0 run', () => {
  const steps = [
    'UserPromptSubmit',
    'PreToolUse.Read',
    'PostToolUse.Read',
    'PreToolUse.Bash',
    'PostToolUse.Bash',
    'PreToolUse.Edit',
    'PostToolUse.Edit',
    'Stop'
  ]

  it('opens the session on the first event and tracks it to the finish', () => {
    const { state, now } = replay(steps)
    const s = state.sessions['session-1']!
    expect(s.project).toBe('demo-project')
    expect(s.status).toBe('done')
    expect(s.finishedAt).toBe(now)
    expect(s.prompt).toMatch(/^Read notes\.txt/)
    expect(s.lastMessage).toContain('bread')
    expect(s.running).toEqual([])
    expect(s.stats).toEqual({ tools: 3, edits: 1, linesAdded: 1, linesRemoved: 0 })
    expect(s.recent.map((a) => `${a.verb} ${a.target} ${a.status}`)).toEqual([
      'Editing notes.txt ok',
      'Running echo hello-from-suri ok',
      'Reading notes.txt ok'
    ])
    expect(s.recent[0]!.diff).toEqual({ added: 1, removed: 0 })
    expect(s.recent[0]!.durationMs).toBe(11) // duration_ms from the payload
  })

  it('shows the running tool while it runs', () => {
    const { state } = replay(steps.slice(0, 2))
    const s = state.sessions['session-1']!
    expect(s.status).toBe('working')
    expect(s.running.map((a) => `${a.verb} ${a.target}`)).toEqual(['Reading notes.txt'])
  })

  it('goes back to thinking once the tool reports back', () => {
    const { state } = replay(steps.slice(0, 3))
    expect(state.sessions['session-1']!.status).toBe('thinking')
  })

  it('removes the session on SessionEnd', () => {
    const { state } = replay([...steps, 'SessionEnd'])
    expect(state.sessions).toEqual({})
  })
})

describe('permissions', () => {
  it('waits on a PermissionRequest, then a denied tool ends as stopped', () => {
    const waiting = replay([
      'UserPromptSubmit',
      'PreToolUse.PowerShell',
      'PermissionRequest.PowerShell'
    ])
    const s = waiting.state.sessions['session-1']!
    expect(s.status).toBe('waiting')
    expect(s.pendingPermission).toMatchObject({ tool: 'PowerShell', target: 'echo run-d3' })

    const done = reduceSessions(waiting.state, hookEvent('Stop', ID), waiting.now + 100)
    const after = done.sessions['session-1']!
    expect(after.status).toBe('done')
    expect(after.pendingPermission).toBeUndefined()
    expect(after.running).toEqual([])
    expect(after.recent[0]).toMatchObject({ tool: 'PowerShell', status: 'stopped' })
  })

  it('treats a "needs you" notification as waiting, and ignores idle prompts', () => {
    const base = { hook_event_name: 'Notification', ...ID }
    const idle = replay(['UserPromptSubmit', { ...base, notification_type: 'idle_prompt' }])
    expect(idle.state.sessions['session-1']!.status).toBe('thinking')

    const ask = replay([
      'UserPromptSubmit',
      { ...base, notification_type: 'permission_prompt', message: 'Claude needs your permission' }
    ])
    expect(ask.state.sessions['session-1']!).toMatchObject({
      status: 'waiting',
      pendingPermission: { tool: 'Claude', target: 'Claude needs your permission' }
    })
  })
})

describe('tool bookkeeping', () => {
  const pre = (id: string, command: string): Record<string, unknown> => ({
    hook_event_name: 'PreToolUse',
    ...ID,
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: id
  })
  const post = (id: string, command: string): Record<string, unknown> => ({
    ...pre(id, command),
    hook_event_name: 'PostToolUse',
    tool_response: { stdout: '' }
  })

  it('tracks tools that run in parallel', () => {
    const both = replay(['UserPromptSubmit', pre('a', 'npm test'), pre('b', 'npm run lint')])
    expect(both.state.sessions['session-1']!.running).toHaveLength(2)

    const one = reduceSessions(both.state, hookEvent(post('a', 'npm test'), ID), both.now + 100)
    expect(one.sessions['session-1']!.status).toBe('working')
    expect(one.sessions['session-1']!.running.map((a) => a.id)).toEqual(['b'])
  })

  it('records a failure', () => {
    const failure = { ...pre('a', 'npm test'), hook_event_name: 'PostToolUseFailure' }
    const { state } = replay(['UserPromptSubmit', pre('a', 'npm test'), failure])
    const s = state.sessions['session-1']!
    expect(s.recent[0]).toMatchObject({ id: 'a', status: 'failed' })
    expect(s.stats.edits).toBe(0)
  })

  it('still records a tool whose PreToolUse never arrived', () => {
    const { state } = replay(['UserPromptSubmit', post('lonely', 'git status')])
    expect(state.sessions['session-1']!.recent[0]).toMatchObject({
      id: 'lonely',
      target: 'git status',
      status: 'ok'
    })
  })

  it('counts subagents', () => {
    const start = { hook_event_name: 'SubagentStart', ...ID }
    const stop = { hook_event_name: 'SubagentStop', ...ID }
    expect(replay([start, start, stop]).state.sessions['session-1']!.subagents).toBe(1)
    expect(replay([stop]).state.sessions['session-1']!.subagents).toBe(0)
  })

  it('explains a StopFailure as best it can', () => {
    const failure = (error: unknown): Record<string, unknown> => ({
      hook_event_name: 'StopFailure',
      ...ID,
      error
    })
    const message = (error: unknown): string | undefined =>
      replay([failure(error)]).state.sessions['session-1']!.errorMessage
    expect(message('rate limited')).toBe('rate limited')
    expect(message({ message: 'API overloaded' })).toBe('API overloaded')
    expect(message(undefined)).toBe('Claude Code stopped with an error.')
  })
})

describe('state hygiene', () => {
  it('leaves other sessions untouched (same objects)', () => {
    const { state } = replay(['UserPromptSubmit'])
    const other = reduceSessions(
      state,
      hookEvent('UserPromptSubmit', { session_id: 'session-2', cwd: 'C:\\work\\portfolio' }),
      5_000
    )
    expect(other.sessions['session-1']).toBe(state.sessions['session-1'])
    expect(other.sessions['session-2']!.project).toBe('portfolio')
  })

  it('prunes quiet sessions, giving running tools longer', () => {
    const idle = replay(['UserPromptSubmit']).state
    expect(pruneSessions(idle, 1_100 + 30 * 60_000 + 1).sessions).toEqual({})
    expect(pruneSessions(idle, 1_100 + 60_000)).toBe(idle)

    const busy = replay(['UserPromptSubmit', 'PreToolUse.Bash']).state
    expect(Object.keys(pruneSessions(busy, 1_200 + 31 * 60_000).sessions)).toEqual(['session-1'])
  })

  it('sorts what needs Paul first, then the most recent', () => {
    let state = replay(['UserPromptSubmit', 'Stop']).state
    state = reduceSessions(
      state,
      hookEvent('PermissionRequest.Bash', { session_id: 'needs-you', cwd: 'C:\\work\\b' }),
      9_000
    )
    state = reduceSessions(
      state,
      hookEvent('PreToolUse.Read', { session_id: 'busy', cwd: 'C:\\work\\c' }),
      9_500
    )
    expect(sortSessions(state).map((s) => s.id)).toEqual(['needs-you', 'busy', 'session-1'])
  })
})
