import { describeTool } from '@shared/activity'
import { isReplay, type HookEvent } from '@shared/hook-events'
import { assessRisk } from '@shared/risk-rules'
import { projectName } from '@shared/sessions'
import type { ApprovalDecision, PendingApproval, RiskFlag } from '@shared/types'
import { riskInputFrom, type RiskInput, type RiskOutcome } from './ai/risk'
import type { HookAnswer } from './hook-server'

type PermissionRequestEvent = Extract<HookEvent, { hook_event_name: 'PermissionRequest' }>

/** The hook's own timeout is 120 s; Suri steps aside a little before it. */
export const APPROVAL_TIMEOUT_MS = 110_000
export const DENY_MESSAGE = 'Denied from Suri.'

/** How a held request ended. `gone` = Claude Code closed the request (or Suri paused). */
export type ApprovalOutcome = ApprovalDecision | 'timeout' | 'gone'

export interface ApprovalBroker {
  /** Holds a PermissionRequest until Paul answers, it times out, or the request goes away. */
  request(event: PermissionRequestEvent, signal?: AbortSignal): Promise<HookAnswer>
  decide(id: string, decision: ApprovalDecision): boolean
  list(): PendingApproval[]
  onChange(listener: () => void): () => void
  /** Steps aside on everything at once (pause, quit). */
  releaseAll(): void
}

interface Held {
  approval: PendingApproval
  resolve: (answer: HookAnswer) => void
  timer: ReturnType<typeof setTimeout>
  /** Stops the AI risk check once the request is answered or gone. */
  stopCheck: AbortController
}

export function createApprovalBroker(
  opts: {
    clock?: () => number
    timeoutMs?: number
    onSettled?: (approval: PendingApproval, outcome: ApprovalOutcome) => void
    /** The AI risk check (risk.ts). */
    explain?: (input: RiskInput, signal: AbortSignal) => Promise<RiskOutcome>
  } = {}
): ApprovalBroker {
  const clock = opts.clock ?? Date.now
  const timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS
  const held = new Map<string, Held>()
  const listeners = new Set<() => void>()
  let counter = 0

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const settle = (id: string, answer: HookAnswer, outcome: ApprovalOutcome): boolean => {
    const entry = held.get(id)
    if (!entry) return false
    held.delete(id)
    clearTimeout(entry.timer)
    // Paul answered (or Claude Code gave up): the GPU can stop explaining.
    entry.stopCheck.abort()
    entry.resolve(answer)
    opts.onSettled?.(entry.approval, outcome)
    emit()
    return true
  }

  /** Fills in the AI's explanation when it arrives, if the request is still held. */
  const check = (id: string, input: RiskInput, signal: AbortSignal): void => {
    const explain = opts.explain
    if (!explain) return
    const failed = (err: unknown): RiskOutcome => ({ ok: false, reason: String(err) })
    let pending: Promise<RiskOutcome>
    try {
      pending = explain(input, signal)
    } catch (err) {
      // Even a synchronous throw must not fail the hook request.
      pending = Promise.resolve(failed(err))
    }
    void pending.catch(failed).then((outcome) => {
      const entry = held.get(id)
      if (!entry) return
      entry.approval = {
        ...entry.approval,
        checkingRisk: false,
        ...(outcome.ok ? { explanation: outcome.explanation } : { riskNote: outcome.reason })
      }
      emit()
    })
  }

  return {
    request(event, signal) {
      if (signal?.aborted) return Promise.resolve(null)
      const now = clock()
      const id = `approval-${++counter}`
      const risk = assessRisk(event.tool_name, event.tool_input, event.cwd)
      const approval: PendingApproval = {
        id,
        sessionId: event.session_id,
        project: projectName(event.cwd),
        tool: event.tool_name,
        verb: describeTool(event.tool_name, event.tool_input, event.cwd).verb,
        detail: fullDetail(event.tool_input),
        ...(risk ? { risk } : {}),
        ...(opts.explain ? { checkingRisk: true } : {}),
        createdAt: now,
        expiresAt: now + timeoutMs,
        ...(isReplay(event) ? { replayed: true as const } : {})
      }
      return new Promise<HookAnswer>((resolve) => {
        const timer = setTimeout(() => settle(id, null, 'timeout'), timeoutMs)
        const stopCheck = new AbortController()
        held.set(id, { approval, resolve, timer, stopCheck })
        signal?.addEventListener('abort', () => settle(id, null, 'gone'), { once: true })
        emit()
        // The card shows the rule at once; the explanation fills in (ADR-016).
        check(
          id,
          riskInputFrom(event.tool_name, event.tool_input, event.cwd, risk),
          stopCheck.signal
        )
      })
    },
    decide: (id, decision) => settle(id, answerFor(decision), decision),
    list: () => [...held.values()].map((entry) => entry.approval),
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    releaseAll() {
      for (const id of [...held.keys()]) settle(id, null, 'gone')
    }
  }
}

/** The documented PermissionRequest answer. `ask` = no answer, so Claude Code prompts. */
export function answerFor(decision: ApprovalDecision): HookAnswer {
  if (decision === 'ask') return null
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision:
        decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: DENY_MESSAGE }
    }
  }
}

/** The safety net's PreToolUse answer: make Claude Code ask, and say why (ADR-007). */
export function safetyNetAnswer(risk: RiskFlag): HookAnswer {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `Suri: ${risk.reason}`
    }
  }
}

function fullDetail(input: Record<string, unknown>): string {
  const pick = (key: string): string | undefined =>
    typeof input[key] === 'string' ? (input[key] as string) : undefined
  const text =
    pick('command') ?? pick('file_path') ?? pick('notebook_path') ?? JSON.stringify(input)
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text
}
