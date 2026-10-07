import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Real payloads captured from Claude Code 2.1.284 in the Phase 0 spike
// (docs/spike-hooks.md), plus a subagent run captured on 2026-10-07, with
// personal paths scrubbed. These tests pin the fields Suri relies on, so a
// Claude Code update that changes them fails here first. Several fields
// differ from what the docs summaries claimed.

type Payload = Record<string, unknown>

const dir = join(process.cwd(), 'tests', 'fixtures', 'hooks')
const load = (name: string): Payload => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const all = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({ file, body: load(file) }))
const ofEvent = (event: string): Payload[] =>
  all.filter(({ body }) => body.hook_event_name === event).map(({ body }) => body)

describe('captured Claude Code hook payloads', () => {
  it('covers every event the spike received', () => {
    const events = new Set(all.map(({ body }) => body.hook_event_name))
    expect([...events].sort()).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'UserPromptSubmit'
    ])
  })

  it("a subagent's events carry its parent's session and prompt, plus its own agent id", () => {
    const parent = load('PreToolUse.Agent.json')
    for (const file of [
      'SubagentStart.json',
      'PreToolUse.Read.subagent.json',
      'PostToolUse.Read.subagent.json',
      'SubagentStop.json'
    ]) {
      const body = load(file)
      expect(body.session_id).toBe(parent.session_id)
      expect(body.prompt_id).toBe(parent.prompt_id)
      expect(body.agent_id).toBe('ad4fcb91a57252fb5')
      expect(body.agent_type).toBe('Explore')
    }
    // The parent's own Agent call has no agent id: that's how the two tell apart.
    expect(parent).not.toHaveProperty('agent_id')
    expect(load('SubagentStop.json').last_assistant_message).toBe('0.1.0')
  })

  it.each(all)('$file carries the common fields', ({ body }) => {
    expect(body.session_id).toEqual(expect.any(String))
    expect(body.cwd).toEqual(expect.any(String))
    expect(body.transcript_path).toEqual(expect.any(String))
    expect(body.hook_event_name).toEqual(expect.any(String))
  })

  it('tool events carry tool_name and tool_input', () => {
    const toolEvents = [
      ...ofEvent('PreToolUse'),
      ...ofEvent('PostToolUse'),
      ...ofEvent('PermissionRequest')
    ]
    expect(toolEvents.length).toBeGreaterThan(0)
    for (const body of toolEvents) {
      expect(body.tool_name).toEqual(expect.any(String))
      expect(body.tool_input).toEqual(expect.any(Object))
    }
  })

  it('PostToolUse reports the result as tool_response, not tool_output', () => {
    for (const body of ofEvent('PostToolUse')) {
      expect(body).toHaveProperty('tool_response')
      expect(body).not.toHaveProperty('tool_output')
      expect(body.duration_ms).toEqual(expect.any(Number))
    }
  })

  it('an Edit result includes a structured patch, so +N -M can be counted', () => {
    const edit = load('PostToolUse.Edit.json') as {
      tool_response: { structuredPatch: { lines: string[] }[] }
    }
    const lines = edit.tool_response.structuredPatch.flatMap((hunk) => hunk.lines)
    expect(lines.filter((line) => line.startsWith('+'))).toEqual(['+- bread'])
    expect(lines.filter((line) => line.startsWith('-'))).toEqual([])
  })

  it('PermissionRequest has no tool_use_id, so it must be matched by session, tool and input', () => {
    const requests = ofEvent('PermissionRequest')
    expect(requests.length).toBeGreaterThan(0)
    for (const body of requests) expect(body).not.toHaveProperty('tool_use_id')
  })

  it('Stop carries the final assistant text', () => {
    const stop = load('Stop.json')
    expect(stop.last_assistant_message).toEqual(expect.any(String))
    expect(stop.stop_hook_active).toBe(false)
  })

  it('SessionEnd names its reason in `reason`', () => {
    expect(load('SessionEnd.json').reason).toEqual(expect.any(String))
  })
})
