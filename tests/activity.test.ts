import { describe, expect, it } from 'vitest'
import { describeTool, diffStatsFromResponse, displayPath, shorten } from '@shared/activity'
import { fixture } from './helpers'

const CWD = 'C:\\work\\demo-project'

describe('describeTool', () => {
  it('shows files relative to the project, or by name when outside it', () => {
    expect(
      describeTool('Read', { file_path: 'C:\\work\\demo-project\\src\\billing.ts' }, CWD)
    ).toEqual({ kind: 'read', verb: 'Reading', target: 'src/billing.ts' })
    expect(describeTool('Edit', { file_path: 'D:\\other\\notes.txt' }, CWD).target).toBe(
      'notes.txt'
    )
    expect(describeTool('Write', { file_path: 'c:/WORK/demo-project/a.md' }, CWD).target).toBe(
      'a.md'
    )
  })

  it('treats Bash and PowerShell commands alike and keeps only the first line', () => {
    expect(describeTool('Bash', { command: 'npm test\nnpm run lint' })).toEqual({
      kind: 'shell',
      verb: 'Running',
      target: 'npm test'
    })
    expect(describeTool('PowerShell', { command: 'Get-ChildItem' }).kind).toBe('shell')
  })

  it('names searches, web calls, agents, planning and MCP tools', () => {
    expect(describeTool('Grep', { pattern: 'TODO' }).target).toBe('TODO')
    expect(describeTool('WebFetch', { url: 'https://docs.example.com/a/b' }).target).toBe(
      'docs.example.com'
    )
    expect(describeTool('Task', { description: 'review the diff' }).verb).toBe('Delegating')
    expect(describeTool('TodoWrite', {})).toEqual({ kind: 'plan', verb: 'Planning', target: '' })
    expect(describeTool('mcp__github__create_issue', {}).target).toBe('github › create_issue')
    expect(describeTool('SomethingNew', {})).toEqual({
      kind: 'other',
      verb: 'Using',
      target: 'SomethingNew'
    })
  })
})

describe('diffStatsFromResponse', () => {
  it('counts the real Edit structuredPatch', () => {
    const edit = fixture('PostToolUse.Edit')
    expect(diffStatsFromResponse('Edit', edit.tool_response)).toEqual({ added: 1, removed: 0 })
  })

  it('counts a new file written with an empty patch', () => {
    const response = { structuredPatch: [], content: 'a\nb\nc\n' }
    expect(diffStatsFromResponse('Write', response)).toEqual({ added: 3, removed: 0 })
  })

  it('gives nothing for results without a patch', () => {
    expect(diffStatsFromResponse('Bash', { stdout: 'ok' })).toBeUndefined()
    expect(diffStatsFromResponse('Edit', 'not an object')).toBeUndefined()
  })
})

describe('text helpers', () => {
  it('shorten collapses whitespace and cuts with an ellipsis', () => {
    expect(shorten('  a   b \n c ', 20)).toBe('a b c')
    expect(shorten('abcdefghij', 5)).toBe('abcd…')
  })

  it('displayPath keeps the tail of long paths', () => {
    const shown = displayPath(`${CWD}\\${'very-long-folder-name\\'.repeat(4)}file.ts`, CWD, 30)
    expect(shown).toHaveLength(30)
    expect(shown.startsWith('…')).toBe(true)
    expect(shown.endsWith('file.ts')).toBe(true)
  })
})
