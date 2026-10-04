import { z } from 'zod'

// Shapes come from real Claude Code 2.1.284 payloads (tests/fixtures/hooks/),
// not from docs summaries. Objects are loose: Claude Code adds fields over
// time, and an unknown field must never make Suri drop an event.

const common = {
  session_id: z.string().min(1),
  cwd: z.string(),
  transcript_path: z.string().optional(),
  prompt_id: z.string().optional(),
  permission_mode: z.string().optional()
}

const toolInput = z.record(z.string(), z.unknown())

const userPromptSubmit = z.looseObject({
  ...common,
  hook_event_name: z.literal('UserPromptSubmit'),
  prompt: z.string()
})

const preToolUse = z.looseObject({
  ...common,
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.string(),
  tool_input: toolInput,
  tool_use_id: z.string().optional()
})

// The result is `tool_response` (not `tool_output`, as a docs summary claimed).
const postToolUse = z.looseObject({
  ...common,
  hook_event_name: z.literal('PostToolUse'),
  tool_name: z.string(),
  tool_input: toolInput,
  tool_response: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  duration_ms: z.number().optional()
})

const postToolUseFailure = z.looseObject({
  ...common,
  hook_event_name: z.literal('PostToolUseFailure'),
  tool_name: z.string(),
  tool_input: toolInput,
  tool_use_id: z.string().optional(),
  error: z.unknown().optional()
})

// No tool_use_id here: a request is matched by session, tool and input.
const permissionRequest = z.looseObject({
  ...common,
  hook_event_name: z.literal('PermissionRequest'),
  tool_name: z.string(),
  tool_input: toolInput
})

const notification = z.looseObject({
  ...common,
  hook_event_name: z.literal('Notification'),
  message: z.string().optional(),
  notification_type: z.string().optional()
})

const stop = z.looseObject({
  ...common,
  hook_event_name: z.literal('Stop'),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional()
})

// Never captured live yet, so the error's shape is unknown.
const stopFailure = z.looseObject({
  ...common,
  hook_event_name: z.literal('StopFailure'),
  error: z.unknown().optional()
})

const subagentStart = z.looseObject({
  ...common,
  hook_event_name: z.literal('SubagentStart'),
  agent_id: z.string().optional(),
  agent_type: z.string().optional()
})

const subagentStop = z.looseObject({
  ...common,
  hook_event_name: z.literal('SubagentStop'),
  agent_id: z.string().optional(),
  agent_type: z.string().optional()
})

// `reason`, not `session_end_reason`.
const sessionEnd = z.looseObject({
  ...common,
  hook_event_name: z.literal('SessionEnd'),
  reason: z.string().optional()
})

export const hookEventSchema = z.discriminatedUnion('hook_event_name', [
  userPromptSubmit,
  preToolUse,
  postToolUse,
  postToolUseFailure,
  permissionRequest,
  notification,
  stop,
  stopFailure,
  subagentStart,
  subagentStop,
  sessionEnd
])

export type HookEvent = z.infer<typeof hookEventSchema>
export type HookEventName = HookEvent['hook_event_name']

/** The events Suri registers. SessionStart can't be an HTTP hook (ADR-003). */
export const SUBSCRIBED_EVENTS: readonly HookEventName[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd'
]

export type ParseResult =
  | { ok: true; event: HookEvent }
  | { ok: false; reason: 'unknown-event'; eventName: string }
  | { ok: false; reason: 'invalid'; issues: string }

/**
 * Validates a hook payload. Events Suri doesn't subscribe to come back as
 * `unknown-event`, so the server can ignore them instead of failing them.
 */
export function parseHookEvent(input: unknown): ParseResult {
  const name =
    typeof input === 'object' && input !== null && 'hook_event_name' in input
      ? String((input as { hook_event_name: unknown }).hook_event_name)
      : ''
  if (!(SUBSCRIBED_EVENTS as readonly string[]).includes(name)) {
    return { ok: false, reason: 'unknown-event', eventName: name }
  }
  const parsed = hookEventSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return { ok: false, reason: 'invalid', issues }
  }
  return { ok: true, event: parsed.data }
}
