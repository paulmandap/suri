import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHookEvent } from '@shared/hook-events'
import { fixture } from './helpers'

const names = readdirSync(join(process.cwd(), 'tests', 'fixtures', 'hooks')).map((f) =>
  f.replace(/\.json$/, '')
)

describe('parseHookEvent', () => {
  it.each(names)('accepts the real %s payload', (name) => {
    const result = parseHookEvent(fixture(name))
    expect(result.ok).toBe(true)
  })

  it('keeps fields it does not know about', () => {
    const result = parseHookEvent({ ...fixture('Stop'), brand_new_field: 42 })
    expect(result.ok && (result.event as Record<string, unknown>).brand_new_field).toBe(42)
  })

  it('reports events Suri does not subscribe to, instead of failing them', () => {
    expect(parseHookEvent({ ...fixture('Stop'), hook_event_name: 'PostToolBatch' })).toEqual({
      ok: false,
      reason: 'unknown-event',
      eventName: 'PostToolBatch'
    })
    expect(parseHookEvent('not an object')).toMatchObject({ ok: false, reason: 'unknown-event' })
  })

  it('rejects a subscribed event that is missing required fields', () => {
    const payload = fixture('PreToolUse.Bash')
    delete payload.session_id
    const result = parseHookEvent(payload)
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(!result.ok && result.reason === 'invalid' && result.issues).toContain('session_id')
  })
})
