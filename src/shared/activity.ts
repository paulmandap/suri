import type { ActivityKind, DiffStats } from './types'

export interface ToolDescription {
  kind: ActivityKind
  verb: string
  target: string
}

const FILE_TOOLS: Record<string, { kind: ActivityKind; verb: string; key: string }> = {
  Read: { kind: 'read', verb: 'Reading', key: 'file_path' },
  Edit: { kind: 'edit', verb: 'Editing', key: 'file_path' },
  MultiEdit: { kind: 'edit', verb: 'Editing', key: 'file_path' },
  Write: { kind: 'write', verb: 'Writing', key: 'file_path' },
  NotebookEdit: { kind: 'edit', verb: 'Editing', key: 'notebook_path' }
}

// Claude Code on Windows has a PowerShell tool next to Bash; both run commands.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

/** Turns a tool call into what the island says: a kind, a verb and a short target. */
export function describeTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd = ''
): ToolDescription {
  const file = FILE_TOOLS[toolName]
  if (file) {
    return { kind: file.kind, verb: file.verb, target: displayPath(text(input[file.key]), cwd) }
  }
  if (SHELL_TOOLS.has(toolName)) {
    return { kind: 'shell', verb: 'Running', target: shorten(firstLine(text(input.command)), 60) }
  }
  if (PLAN_TOOLS.has(toolName)) return { kind: 'plan', verb: 'Planning', target: '' }
  switch (toolName) {
    case 'Glob':
      return { kind: 'search', verb: 'Finding', target: shorten(text(input.pattern), 48) }
    case 'Grep':
      return { kind: 'search', verb: 'Searching', target: shorten(text(input.pattern), 48) }
    case 'WebFetch':
      return { kind: 'web', verb: 'Fetching', target: hostOf(text(input.url)) }
    case 'WebSearch':
      return { kind: 'web', verb: 'Searching the web', target: shorten(text(input.query), 48) }
    case 'Task':
    case 'Agent':
      return {
        kind: 'agent',
        verb: 'Delegating',
        target: shorten(text(input.description) || text(input.subagent_type), 48)
      }
  }
  if (toolName.startsWith('mcp__')) {
    const [, server = '', ...rest] = toolName.split('__')
    const target = rest.length > 0 ? `${server} › ${rest.join('__')}` : server
    return { kind: 'other', verb: 'Using', target: shorten(target, 48) }
  }
  return { kind: 'other', verb: 'Using', target: shorten(toolName, 48) }
}

/**
 * Counts added and removed lines in an Edit/Write result. Claude Code sends a
 * ready-made unified diff in `tool_response.structuredPatch` (see fixtures).
 */
export function diffStatsFromResponse(toolName: string, response: unknown): DiffStats | undefined {
  if (!isRecord(response)) return undefined
  const patch = response.structuredPatch
  if (Array.isArray(patch) && patch.length > 0) {
    let added = 0
    let removed = 0
    for (const hunk of patch) {
      const lines: unknown[] = isRecord(hunk) && Array.isArray(hunk.lines) ? hunk.lines : []
      for (const line of lines) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) added++
        else if (line.startsWith('-')) removed++
      }
    }
    return { added, removed }
  }
  // A brand-new file comes with an empty patch; count its lines instead.
  if (toolName === 'Write' && typeof response.content === 'string') {
    return { added: countLines(response.content), removed: 0 }
  }
  return undefined
}

/** One line, collapsed whitespace, cut with an ellipsis. */
export function shorten(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Relative to the project when the file is inside it, else the file name. Long paths keep their tail. */
export function displayPath(path: string, cwd: string, max = 48): string {
  if (!path) return ''
  const p = path.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const inside = base !== '' && p.toLowerCase().startsWith(`${base.toLowerCase()}/`)
  const shown = inside ? p.slice(base.length + 1) : p.split('/').pop() || p
  return shown.length > max ? `…${shown.slice(shown.length - (max - 1))}` : shown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0] ?? ''
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || shorten(url, 48)
  } catch {
    return shorten(url, 48)
  }
}

function countLines(content: string): number {
  if (content === '') return 0
  return content.replace(/\r?\n$/, '').split(/\r?\n/).length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
