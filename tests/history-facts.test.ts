import { describe, expect, it } from 'vitest'
import {
  MAX_COMMANDS,
  MAX_FILES,
  buildTurnFacts,
  commandLine,
  dayKey,
  dayLabel,
  dayTitle,
  durationLabel,
  previousDay,
  turnTitle,
  type StepRecord
} from '@shared/history'
import { daySchema, parseColumn, recapSchema, turnIdSchema } from '@shared/history-schemas'

const CWD = 'C:\\work\\demo'
const step = (over: Partial<StepRecord>): StepRecord => ({
  tool: 'Bash',
  kind: 'shell',
  detail: 'npm test',
  status: 'ok',
  ...over
})

describe('buildTurnFacts', () => {
  it('adds up changes per file, relative to the project, whatever the case', () => {
    const facts = buildTurnFacts(
      [
        step({
          tool: 'Edit',
          kind: 'edit',
          detail: 'C:\\work\\demo\\src\\a.ts',
          added: 3,
          removed: 1
        }),
        step({ tool: 'Write', kind: 'write', detail: 'C:\\work\\demo\\README.md', added: 10 }),
        step({ tool: 'Edit', kind: 'edit', detail: 'c:/work/demo/src/A.ts', added: 2, removed: 2 }),
        step({ tool: 'Edit', kind: 'edit', detail: 'D:\\elsewhere\\notes.txt', added: 1 })
      ],
      CWD,
      5000
    )
    expect(facts.filesChanged).toEqual([
      { path: 'src/a.ts', added: 5, removed: 3 },
      { path: 'README.md', added: 10, removed: 0 },
      { path: 'notes.txt', added: 1, removed: 0 }
    ])
    expect(facts).toMatchObject({ linesAdded: 16, linesRemoved: 3, steps: 4, durationMs: 5000 })
  })

  it("doesn't count an edit that failed or never finished", () => {
    const facts = buildTurnFacts(
      [
        step({ tool: 'Edit', kind: 'edit', detail: 'C:\\work\\demo\\a.ts', status: 'failed' }),
        step({ tool: 'Edit', kind: 'edit', detail: 'C:\\work\\demo\\b.ts', status: 'stopped' })
      ],
      CWD,
      0
    )
    expect(facts.filesChanged).toEqual([])
    expect(facts.failed).toBe(1)
  })

  it('keeps every command in order, and only the latest when there are many', () => {
    const steps = Array.from({ length: MAX_COMMANDS + 3 }, (_, i) =>
      step({ detail: `echo ${i}`, status: i === MAX_COMMANDS + 2 ? 'failed' : 'ok' })
    )
    steps.push(step({ detail: 'npm run build', status: 'running' }))
    const facts = buildTurnFacts(steps, CWD, 0)
    expect(facts.commands).toHaveLength(MAX_COMMANDS)
    expect(facts.moreCommands).toBe(4)
    expect(facts.commands.at(-2)).toEqual({ command: `echo ${MAX_COMMANDS + 2}`, status: 'failed' })
    // A command still running when the turn ended never reported back.
    expect(facts.commands.at(-1)).toEqual({ command: 'npm run build', status: 'stopped' })
  })

  it('lists at most MAX_FILES files and counts the rest', () => {
    const steps = Array.from({ length: MAX_FILES + 2 }, (_, i) =>
      step({ tool: 'Write', kind: 'write', detail: `C:\\work\\demo\\f${i}.ts`, added: 1 })
    )
    const facts = buildTurnFacts(steps, CWD, 0)
    expect(facts.filesChanged).toHaveLength(MAX_FILES)
    expect(facts.moreFiles).toBe(2)
    expect(facts.linesAdded).toBe(MAX_FILES + 2)
  })

  it('counts reads, searches, web lookups and subagents', () => {
    const facts = buildTurnFacts(
      [
        step({ tool: 'Read', kind: 'read' }),
        step({ tool: 'Read', kind: 'read' }),
        step({ tool: 'Grep', kind: 'search' }),
        step({ tool: 'WebFetch', kind: 'web' }),
        step({ tool: 'Task', kind: 'agent' }),
        step({ tool: 'TodoWrite', kind: 'plan' })
      ],
      CWD,
      -5
    )
    expect(facts).toMatchObject({
      reads: 2,
      searches: 1,
      web: 1,
      agents: 1,
      steps: 6,
      durationMs: 0
    })
  })
})

describe('commandLine', () => {
  it('keeps the first line and marks that more followed', () => {
    expect(commandLine('  npm   test  ')).toBe('npm test')
    expect(commandLine('cat <<EOF > a.txt\nhello\nEOF')).toBe('cat <<EOF > a.txt …')
    expect(commandLine(`echo ${'x'.repeat(300)}`).length).toBeLessThanOrEqual(160)
  })
})

describe('days', () => {
  it('uses the local date, not UTC', () => {
    expect(dayKey(new Date(2026, 9, 7, 0, 5).getTime())).toBe('2026-10-07')
    expect(dayKey(new Date(2026, 9, 7, 23, 55).getTime())).toBe('2026-10-07')
  })

  it('steps back across months and years', () => {
    expect(previousDay('2026-10-07')).toBe('2026-10-06')
    expect(previousDay('2026-03-01')).toBe('2026-02-28')
    expect(previousDay('2026-01-01')).toBe('2025-12-31')
  })

  it('names days the way Paul says them', () => {
    expect(dayTitle('2026-10-07')).toBe('Wednesday 7 October 2026')
    expect(dayLabel('2026-10-07', '2026-10-07')).toBe('Today')
    expect(dayLabel('2026-10-06', '2026-10-07')).toBe('Yesterday')
    expect(dayLabel('2026-10-05', '2026-10-07')).toBe('Mon 5 Oct')
    expect(dayLabel('2025-12-31', '2026-10-07')).toBe('Wed 31 Dec 2025')
  })
})

describe('labels', () => {
  it('says how long, briefly', () => {
    expect(durationLabel(45_000)).toBe('45 s')
    expect(durationLabel(3 * 60_000)).toBe('3 min')
    expect(durationLabel(80 * 60_000)).toBe('1 h 20 min')
    expect(durationLabel(120 * 60_000)).toBe('2 h')
  })

  it('names a turn by its recap, else its request, else its answer', () => {
    const recap = {
      title: 'Fix the login',
      summary: '',
      outcome: 'done' as const,
      followUps: [],
      model: 'm'
    }
    expect(turnTitle({ recap, prompt: 'p' })).toBe('Fix the login')
    expect(turnTitle({ prompt: 'please   fix it' })).toBe('please fix it')
    expect(turnTitle({ lastMessage: 'Done.' })).toBe('Done.')
    expect(turnTitle({})).toBe('A turn Suri saw only part of')
  })
})

describe('history schemas', () => {
  it('accepts real days and turn ids only', () => {
    expect(daySchema.safeParse('2026-10-07').success).toBe(true)
    for (const bad of ['2026-13-01', '2026-10-7', '../../x', '2026-10-07; DROP', 7]) {
      expect(daySchema.safeParse(bad).success).toBe(false)
    }
    expect(turnIdSchema.safeParse(3).success).toBe(true)
    for (const bad of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 2]) {
      expect(turnIdSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('reads a broken JSON column as missing', () => {
    expect(parseColumn('{oops', recapSchema)).toBeUndefined()
    expect(parseColumn('{"title":"x"}', recapSchema)).toBeUndefined()
    expect(parseColumn(null, recapSchema)).toBeUndefined()
  })
})
