import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HookEvent } from '@shared/hook-events'
import type { RiskExplanation } from '@shared/types'
import type { RiskInput, RiskOutcome } from '../src/main/ai/risk'
import {
  APPROVAL_TIMEOUT_MS,
  DENY_MESSAGE,
  answerFor,
  createApprovalBroker,
  safetyNetAnswer
} from '../src/main/approvals'
import { hookEvent } from './helpers'

const EXPLANATION: RiskExplanation = {
  level: 'high',
  modelLevel: 'high',
  summary: 'Deletes everything on drive C.',
  reasons: ['Nothing can bring it back.'],
  reversible: false,
  route: { provider: 'ollama', model: 'qwen3.5:9b' }
}

/** An explain() the test settles by hand, recording what it was asked. */
function manualExplain(): {
  explain: (input: RiskInput, signal: AbortSignal) => Promise<RiskOutcome>
  asked: { input: RiskInput; signal: AbortSignal }[]
  settle: (outcome: RiskOutcome | Error) => void
} {
  const asked: { input: RiskInput; signal: AbortSignal }[] = []
  let settle: (outcome: RiskOutcome | Error) => void = () => {}
  const explain = (input: RiskInput, signal: AbortSignal): Promise<RiskOutcome> => {
    asked.push({ input, signal })
    return new Promise((resolve, reject) => {
      settle = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome))
    })
  }
  return { explain, asked, settle: (outcome) => settle(outcome) }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type PermissionRequest = Extract<HookEvent, { hook_event_name: 'PermissionRequest' }>

function permissionRequest(command = 'npm install left-pad'): PermissionRequest {
  return hookEvent('PermissionRequest.Bash', {
    session_id: 'session-1',
    cwd: 'C:\\work\\demo-project',
    tool_input: { command }
  }) as PermissionRequest
}

afterEach(() => {
  vi.useRealTimers()
})

describe('approval broker', () => {
  it('holds the request until Paul allows it', async () => {
    const onSettled = vi.fn()
    const broker = createApprovalBroker({ onSettled })
    const answer = broker.request(permissionRequest())
    const [held] = broker.list()
    expect(held).toMatchObject({
      sessionId: 'session-1',
      project: 'demo-project',
      tool: 'Bash',
      verb: 'Running',
      detail: 'npm install left-pad'
    })
    expect(broker.decide(held!.id, 'allow')).toBe(true)
    expect(await answer).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
    })
    expect(broker.list()).toEqual([])
    expect(onSettled).toHaveBeenCalledWith(held, 'allow')
  })

  it('denies with a message Claude can repeat, or steps aside on "ask"', async () => {
    const broker = createApprovalBroker()
    const denied = broker.request(permissionRequest())
    broker.decide(broker.list()[0]!.id, 'deny')
    expect(await denied).toEqual(answerFor('deny'))
    expect(JSON.stringify(await denied)).toContain(DENY_MESSAGE)

    const asked = broker.request(permissionRequest())
    broker.decide(broker.list()[0]!.id, 'ask')
    expect(await asked).toBeNull()
  })

  it('steps aside on its own just before the hook times out', async () => {
    vi.useFakeTimers()
    const onSettled = vi.fn()
    const broker = createApprovalBroker({ onSettled })
    const answer = broker.request(permissionRequest())
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS - 1)
    expect(broker.list()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(await answer).toBeNull()
    expect(onSettled).toHaveBeenCalledWith(expect.anything(), 'timeout')
  })

  it('drops the request when Claude Code stops waiting for it', async () => {
    const broker = createApprovalBroker()
    const gone = new AbortController()
    const answer = broker.request(permissionRequest(), gone.signal)
    gone.abort()
    expect(await answer).toBeNull()
    expect(broker.list()).toEqual([])

    const alreadyGone = new AbortController()
    alreadyGone.abort()
    expect(await broker.request(permissionRequest(), alreadyGone.signal)).toBeNull()
    expect(broker.list()).toEqual([])
  })

  it('queues several requests, oldest first, and answers each only once', async () => {
    const changes = vi.fn()
    const broker = createApprovalBroker()
    broker.onChange(changes)
    const first = broker.request(permissionRequest('npm test'))
    const second = broker.request(permissionRequest('npm run lint'))
    const [a, b] = broker.list()
    expect([a!.detail, b!.detail]).toEqual(['npm test', 'npm run lint'])
    expect(a!.id).not.toBe(b!.id)
    expect(broker.decide(a!.id, 'allow')).toBe(true)
    expect(broker.decide(a!.id, 'deny')).toBe(false)
    expect(broker.decide('nope', 'allow')).toBe(false)
    broker.releaseAll()
    expect(await first).not.toBeNull()
    expect(await second).toBeNull()
    expect(changes).toHaveBeenCalledTimes(4) // two adds, one answer, one release
  })

  it('attaches the safety-net risk and keeps the full command', async () => {
    const broker = createApprovalBroker()
    void broker.request(permissionRequest('rm -rf /'))
    void broker.request(permissionRequest(`echo ${'x'.repeat(3000)}`))
    const [risky, long] = broker.list()
    expect(risky!.risk).toMatchObject({ level: 'high', rule: 'wide-delete' })
    expect(long!.detail).toHaveLength(2000)
    expect(long!.detail.endsWith('…')).toBe(true)
    broker.releaseAll()
  })
})

describe('approval broker: the AI risk check', () => {
  it('asks with the rule and the project folder, then fills the card in', async () => {
    const { explain, asked, settle } = manualExplain()
    const changes = vi.fn()
    const broker = createApprovalBroker({ explain })
    broker.onChange(changes)
    void broker.request(permissionRequest('rm -rf /'))
    expect(broker.list()[0]).toMatchObject({ checkingRisk: true, risk: { rule: 'wide-delete' } })
    expect(broker.list()[0]?.explanation).toBeUndefined()
    expect(asked[0]?.input).toMatchObject({
      tool: 'Bash',
      detail: 'rm -rf /',
      cwd: 'C:\\work\\demo-project',
      rule: { level: 'high', rule: 'wide-delete' }
    })

    settle({ ok: true, explanation: EXPLANATION })
    await tick()
    expect(broker.list()[0]).toMatchObject({ checkingRisk: false, explanation: EXPLANATION })
    expect(changes).toHaveBeenCalledTimes(2) // held, then explained
    broker.releaseAll()
  })

  it('says why there is no explanation, or that the check broke', async () => {
    const failing = manualExplain()
    const broker = createApprovalBroker({ explain: failing.explain })
    void broker.request(permissionRequest())
    failing.settle({ ok: false, reason: "Can't reach Ollama. Is it running?" })
    await tick()
    expect(broker.list()[0]).toMatchObject({
      checkingRisk: false,
      riskNote: "Can't reach Ollama. Is it running?"
    })
    expect(broker.list()[0]?.explanation).toBeUndefined()

    const broken = manualExplain()
    const other = createApprovalBroker({ explain: broken.explain })
    void other.request(permissionRequest())
    broken.settle(new Error('boom'))
    await tick()
    expect(other.list()[0]).toMatchObject({ checkingRisk: false, riskNote: 'Error: boom' })
    broker.releaseAll()
    other.releaseAll()
  })

  it('stops the check once Paul answers, and ignores a late explanation', async () => {
    const { explain, asked, settle } = manualExplain()
    const broker = createApprovalBroker({ explain })
    const answer = broker.request(permissionRequest())
    broker.decide(broker.list()[0]!.id, 'allow')
    expect(asked[0]?.signal.aborted).toBe(true)
    settle({ ok: true, explanation: EXPLANATION })
    await tick()
    expect(broker.list()).toEqual([])
    expect(await answer).toEqual(answerFor('allow'))
  })

  it('runs no check without an explainer', () => {
    const broker = createApprovalBroker()
    void broker.request(permissionRequest())
    expect(broker.list()[0]?.checkingRisk).toBeUndefined()
    broker.releaseAll()
  })

  it('keeps holding the request when the check throws straight away', async () => {
    const broker = createApprovalBroker({
      explain: () => {
        throw new Error('broken')
      }
    })
    const answer = broker.request(permissionRequest())
    await tick()
    expect(broker.list()[0]).toMatchObject({ checkingRisk: false, riskNote: 'Error: broken' })
    broker.decide(broker.list()[0]!.id, 'deny')
    expect(await answer).toEqual(answerFor('deny'))
  })
})

describe('answers', () => {
  it('the safety net asks Claude Code to prompt, with Suri’s reason', () => {
    expect(safetyNetAnswer({ level: 'high', rule: 'force-push', reason: 'Force-pushes.' })).toEqual(
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'Suri: Force-pushes.'
        }
      }
    )
  })
})

describe('replays', () => {
  it('marks a request `npm run replay` sent, so its answer stays out of History', async () => {
    const broker = createApprovalBroker()
    void broker.request(
      hookEvent('PermissionRequest.Bash', { suri_replay: true }) as PermissionRequest
    )
    void broker.request(hookEvent('PermissionRequest.Bash') as PermissionRequest)
    expect(broker.list().map((a) => a.replayed)).toEqual([true, undefined])
    broker.releaseAll()
  })
})
