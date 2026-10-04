import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHookEvent, type HookEvent } from '@shared/hook-events'

/** A captured payload from tests/fixtures/hooks, as raw JSON. */
export function fixture(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests', 'fixtures', 'hooks', `${name}.json`)
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** A fixture (or a hand-made payload) parsed into a HookEvent, with overrides. */
export function hookEvent(
  nameOrPayload: string | Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): HookEvent {
  const base = typeof nameOrPayload === 'string' ? fixture(nameOrPayload) : nameOrPayload
  const parsed = parseHookEvent({ ...base, ...overrides })
  if (!parsed.ok) throw new Error(`test payload rejected: ${JSON.stringify(parsed)}`)
  return parsed.event
}
