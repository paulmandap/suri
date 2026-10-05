import { describe, expect, it } from 'vitest'
import { SUBSCRIBED_EVENTS } from '@shared/hook-events'
import {
  hookUrl,
  inspectHooks,
  isSuriHook,
  maskSecrets,
  parseSettings,
  planHookEdit,
  suriGroup,
  type HookTarget
} from '@shared/hook-config'

// Rules ported from Coucou's installer tests (MIT), plus Suri's own.

const TARGET: HookTarget = { port: 47821, token: 'a'.repeat(64) }
const OLD: HookTarget = { port: 47000, token: 'b'.repeat(64) }
const BOM = '\uFEFF'

const NOTIFY = { type: 'command', command: 'node C:\\tools\\notify.js' }
const ECHO = { type: 'command', command: 'echo done' }

// Like a real user file: other settings, and another tool's hooks.
const ORIGINAL =
  JSON.stringify(
    {
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'], deny: [] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [NOTIFY] }],
        Stop: [{ hooks: [ECHO] }]
      },
      statusLine: { type: 'command', command: 'echo hi' }
    },
    null,
    2
  ) + '\n'

function install(text: string | null, target = TARGET): string {
  const plan = planHookEdit(text, 'install', target)
  if (!plan.ok) throw new Error(plan.error)
  return plan.after
}

function uninstall(text: string | null): string {
  const plan = planHookEdit(text, 'uninstall', TARGET)
  if (!plan.ok) throw new Error(plan.error)
  return plan.after
}

// Lets the tests reach deep into parsed settings without a cast at every step.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (text: string): Record<string, any> => JSON.parse(text.replace(BOM, ''))

describe('parseSettings', () => {
  it('strips a UTF-8 BOM (PowerShell 5.1) instead of treating it as corruption', () => {
    const parsed = parseSettings(BOM + '{"model":"opus"}')
    expect(parsed).toMatchObject({ ok: true, data: { model: 'opus' }, style: { bom: true } })
  })

  it.each(['{ not json', '[1,2,3]', '"a string"', 'null', '42', '// note\n{}'])(
    'refuses %j instead of treating it as empty',
    (text) => {
      expect(parseSettings(text).ok).toBe(false)
    }
  )

  it('starts from nothing for a missing, empty or whitespace-only file', () => {
    for (const text of [null, '', '  \r\n\t']) {
      expect(parseSettings(text)).toMatchObject({ ok: true, data: {} })
    }
  })
})

describe('install', () => {
  it('adds one group per event Suri listens to, with a matcher on tool events', () => {
    const hooks = json(install(null)).hooks
    expect(Object.keys(hooks)).toEqual([...SUBSCRIBED_EVENTS])
    for (const event of SUBSCRIBED_EVENTS) expect(hooks[event]).toEqual([suriGroup(event, TARGET)])
    expect(hooks.PreToolUse[0]).toEqual({
      matcher: '*',
      hooks: [
        {
          type: 'http',
          url: 'http://127.0.0.1:47821/hooks',
          headers: { Authorization: `Bearer ${TARGET.token}` },
          timeout: 10
        }
      ]
    })
    expect(hooks.UserPromptSubmit[0].matcher).toBeUndefined()
    expect(hooks.PermissionRequest[0].hooks[0].timeout).toBe(120)
    expect(hooks.SessionEnd[0].hooks[0].timeout).toBe(2)
  })

  it("keeps every other setting and every other tool's hook in its place", () => {
    const before = json(ORIGINAL)
    const after = json(install(ORIGINAL))
    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(after.model).toBe('opus')
    expect(after.permissions).toEqual(before.permissions)
    expect(after.statusLine).toEqual(before.statusLine)
    expect(after.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [NOTIFY] },
      suriGroup('PreToolUse', TARGET)
    ])
    expect(after.hooks.Stop).toEqual([{ hooks: [ECHO] }, suriGroup('Stop', TARGET)])
  })

  it('changes nothing when Suri is already installed', () => {
    expect(planHookEdit(install(ORIGINAL), 'install', TARGET)).toMatchObject({ changed: false })
  })

  it('replaces an old install (another port and token) instead of adding a second one', () => {
    const hooks = json(install(install(ORIGINAL, OLD))).hooks
    for (const event of SUBSCRIBED_EVENTS) {
      const suri = hooks[event].flatMap((g: { hooks: unknown[] }) => g.hooks).filter(isSuriHook)
      expect(suri).toEqual(suriGroup(event, TARGET).hooks)
    }
    expect(hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [NOTIFY] })
  })

  it("keeps the file's indentation, line endings, final newline and BOM", () => {
    const before = BOM + JSON.stringify({ model: 'opus' }, null, 4).replace(/\n/g, '\r\n')
    const after = install(before)
    expect(after.startsWith(BOM + '{\r\n    "model": "opus",\r\n    "hooks": {')).toBe(true)
    expect(after.replace(/\r\n/g, '')).not.toContain('\n')
    expect(after.endsWith('}')).toBe(true)
  })

  it('writes a fresh file (two-space indent, final newline) when there is none yet', () => {
    const after = install(null)
    expect(after.startsWith('{\n  "hooks": {\n    "UserPromptSubmit": [')).toBe(true)
    expect(after.endsWith('}\n')).toBe(true)
  })

  it.each([
    ['hooks is a list', { hooks: [] }],
    ['an event is not a list', { hooks: { PreToolUse: { matcher: '*' } } }]
  ])('refuses a file where %s', (_label, data) => {
    const plan = planHookEdit(JSON.stringify(data), 'install', TARGET)
    expect(plan.ok).toBe(false)
  })
})

describe('uninstall', () => {
  it.each([
    ['a file with other hooks', ORIGINAL],
    ['an empty object', '{}\n'],
    ['a file without hooks', JSON.stringify({ model: 'opus', theme: 'dark' }, null, 2) + '\n'],
    [
      'a CRLF file with a BOM',
      BOM + JSON.stringify({ a: [1, { b: 2 }] }, null, 4).replace(/\n/g, '\r\n')
    ],
    ['a tab-indented file', JSON.stringify({ hooks: { Stop: [{ hooks: [ECHO] }] } }, null, '\t')],
    ['a file with stray whitespace around it', '\r\n {\r\n  "model": "opus"\r\n}\r\n \t'],
    ['a file without a final newline', '{\n  "model": "opus"\n}']
  ])('gives back the exact original bytes after an install (%s)', (_label, original) => {
    const installed = install(original)
    expect(installed).not.toBe(original)
    expect(uninstall(installed)).toBe(original)
  })

  it("removes only Suri's hook from a group it shares with another tool", () => {
    const shared = {
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [suriGroup('PreToolUse', TARGET).hooks, NOTIFY].flat() }
        ]
      }
    }
    expect(json(uninstall(JSON.stringify(shared)))).toEqual({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [NOTIFY] }] }
    })
  })

  it("leaves a file without Suri's hooks untouched", () => {
    expect(planHookEdit(ORIGINAL, 'uninstall', TARGET)).toEqual({
      ok: true,
      after: ORIGINAL,
      changed: false
    })
    expect(planHookEdit(null, 'uninstall', TARGET)).toMatchObject({ ok: true, changed: false })
  })

  it('never touches hooks that only look like Suri', () => {
    const lookalikes = [
      {
        type: 'http',
        url: 'http://127.0.0.1:47821/hooks',
        headers: { Authorization: 'Bearer spike-token' }
      },
      {
        type: 'http',
        url: 'http://127.0.0.1:47821/hook',
        headers: { Authorization: `Bearer ${TARGET.token}` }
      },
      {
        type: 'http',
        url: 'http://example.com:47821/hooks',
        headers: { Authorization: `Bearer ${TARGET.token}` }
      },
      {
        type: 'http',
        url: 'https://127.0.0.1:47821/hooks',
        headers: { Authorization: `Bearer ${TARGET.token}` }
      },
      { type: 'http', url: 'http://127.0.0.1:47821/hooks' },
      { type: 'command', command: `curl -X POST ${hookUrl(47821)}` }
    ]
    for (const hook of lookalikes) expect(isSuriHook(hook)).toBe(false)
    const text = JSON.stringify({ hooks: { Stop: [{ hooks: lookalikes }] } }, null, 2) + '\n'
    expect(uninstall(install(text))).toBe(text)
  })
})

describe('isSuriHook', () => {
  it('recognises Suri on any port, through localhost, and with any header case', () => {
    const hook = suriGroup('Stop', TARGET).hooks as unknown[]
    expect(isSuriHook(hook[0])).toBe(true)
    expect(
      isSuriHook({
        type: 'http',
        url: 'http://localhost:50000/hooks',
        headers: { authorization: `Bearer ${OLD.token}` }
      })
    ).toBe(true)
  })
})

describe('inspectHooks', () => {
  it("reports not-installed and counts other tools' hooks", () => {
    expect(inspectHooks(ORIGINAL, TARGET)).toEqual({
      state: 'not-installed',
      suriHooks: 0,
      otherHooks: 2,
      warnings: []
    })
    expect(inspectHooks(null, TARGET).state).toBe('not-installed')
  })

  it('reports installed only for an exact install', () => {
    expect(inspectHooks(install(ORIGINAL), TARGET)).toEqual({
      state: 'installed',
      suriHooks: SUBSCRIBED_EVENTS.length,
      otherHooks: 2,
      warnings: []
    })
  })

  it('says why an install is outdated', () => {
    const otherPort = inspectHooks(install(ORIGINAL, { ...TARGET, port: 47000 }), TARGET)
    expect(otherPort).toMatchObject({ state: 'outdated' })
    expect(otherPort.detail).toBe('They send to port 47000, but Suri now listens on 47821.')

    const otherToken = inspectHooks(install(ORIGINAL, { ...TARGET, token: OLD.token }), TARGET)
    expect(otherToken.detail).toBe("Their token doesn't match this copy of Suri.")

    const data = json(install(ORIGINAL))
    data.hooks.Stop = [{ hooks: [ECHO] }]
    const missing = inspectHooks(JSON.stringify(data), TARGET)
    expect(missing).toMatchObject({ state: 'outdated', detail: 'Missing: Stop.' })
  })

  it('reports a file it cannot read, with the reason', () => {
    const result = inspectHooks('{ "model": ', TARGET)
    expect(result.state).toBe('unreadable')
    expect(result.detail).toMatch(/^It isn't valid JSON/)
    expect(inspectHooks('{"hooks": {"Stop": 1}}', TARGET).state).toBe('unreadable')
  })

  it('warns about settings that would keep the hooks from running', () => {
    const off = inspectHooks(JSON.stringify({ disableAllHooks: true }), TARGET)
    expect(off.warnings).toEqual([
      '"disableAllHooks" is on in this file, so Claude Code runs no hooks at all.'
    ])
    const limited = inspectHooks(JSON.stringify({ allowedHttpHookUrls: ['https://*'] }), TARGET)
    expect(limited.warnings[0]).toContain('http://127.0.0.1:47821/hooks')
    const allowed = inspectHooks(
      JSON.stringify({ allowedHttpHookUrls: ['http://127.0.0.1:*'] }),
      TARGET
    )
    expect(allowed.warnings).toEqual([])
  })
})

describe('maskSecrets', () => {
  it("hides Suri's token but keeps the scheme", () => {
    expect(maskSecrets(`  "Authorization": "Bearer ${TARGET.token}"`, [TARGET.token])).toBe(
      '  "Authorization": "Bearer ••••••••"'
    )
  })

  it('hides the value of any key that looks like a secret', () => {
    const cases = [
      ['    "ANTHROPIC_API_KEY": "sk-ant-123",', '    "ANTHROPIC_API_KEY": "••••••••",'],
      ['    "GITHUB_TOKEN": "ghp_abc"', '    "GITHUB_TOKEN": "••••••••"'],
      ['  "Authorization": "Basic dXNlcjpwYXNz",', '  "Authorization": "Basic ••••••••",']
    ]
    for (const [line, masked] of cases) expect(maskSecrets(line, [])).toBe(masked)
  })

  it('leaves ordinary lines alone', () => {
    for (const line of ['  "model": "opus",', '      "Bash(npm test)",', '  "timeout": 10']) {
      expect(maskSecrets(line, [TARGET.token])).toBe(line)
    }
  })
})
