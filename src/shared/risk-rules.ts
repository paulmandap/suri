import type { RiskFlag, RiskLevel } from './types'

// The safety net's first rules (ADR-007). Instant and deterministic: they run
// on every tool call, so no model and no I/O. Only `high` forces a prompt;
// `medium` is shown on the approval card for context. Phase 4 adds an LLM
// explanation on top, but it can never lower what a rule says.

interface Rule {
  id: string
  level: RiskLevel
  reason: string
  test: (command: string) => boolean
}

// Delete commands across bash, PowerShell (incl. its aliases) and cmd.
const DELETE = /(?:^|[\s;&|(])(rm|rmdir|rd|del|erase|ri|remove-item)\b([^;&|\n]*)/gi
const RECURSIVE = /(^|\s)(-[a-z]*r[a-z]*|--recursive|-recurse|\/s)(?=\s|$)/i
// A whole drive, the home folder, the filesystem root, or "everything here".
const BROAD_TARGET =
  /(^|\s)(["']?)(\/|\/\*|~|~[\\/]|~[\\/]\*|\$home|\$env:userprofile|%userprofile%|\*|\.|\.[\\/]\*|\.\.|[a-z]:[\\/]?|[a-z]:[\\/]\*|\/[a-z]\/?)\2(?=\s|$)/i

function deletes(command: string): { recursive: boolean; broad: boolean }[] {
  const found: { recursive: boolean; broad: boolean }[] = []
  for (const match of command.matchAll(DELETE)) {
    const args = match[2] ?? ''
    found.push({ recursive: RECURSIVE.test(args), broad: BROAD_TARGET.test(args) })
  }
  return found
}

const SHELL_RULES: Rule[] = [
  {
    id: 'wide-delete',
    level: 'high',
    reason: 'Deletes a whole drive, your home folder, or everything in this folder.',
    test: (c) => deletes(c).some((d) => d.recursive && d.broad)
  },
  {
    id: 'pipe-to-shell',
    level: 'high',
    reason: 'Downloads a script from the internet and runs it straight away.',
    test: (c) =>
      /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i.test(c) ||
      /\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|\n]*\|\s*(iex|invoke-expression)\b/i.test(
        c
      ) ||
      /\b(iex|invoke-expression)\b\s*\(\s*(iwr|irm|invoke-webrequest|invoke-restmethod|\(?new-object)/i.test(
        c
      )
  },
  {
    id: 'force-push',
    level: 'high',
    reason: 'Force-pushes, which can overwrite commits on the remote.',
    test: (c) => /\bgit\s+push\b[^;&|\n]*\s(--force(?!-with-lease)|-f)(?=\s|$)/i.test(c)
  },
  {
    id: 'discard-work',
    level: 'high',
    reason: 'Throws away uncommitted work for good.',
    test: (c) =>
      /\bgit\s+reset\b[^;&|\n]*\s--hard\b/i.test(c) || /\bgit\s+clean\s+-[a-z]*f/i.test(c)
  },
  {
    id: 'disk-or-system',
    level: 'high',
    reason: 'Changes disks or Windows system settings.',
    test: (c) =>
      /\b(format\s+[a-z]:|diskpart|mkfs(\.\w+)?\b|bcdedit|reg(\.exe)?\s+delete)/i.test(c) ||
      /\bdd\b[^;&|\n]*\bof=\/dev\//i.test(c) ||
      /\bremove-item(property)?\b[^;&|\n]*\bhk(lm|cu):/i.test(c)
  },
  {
    id: 'shutdown',
    level: 'high',
    reason: 'Shuts down or restarts the computer.',
    test: (c) => /\bshutdown(\.exe)?\s+[/-][srh]\b|\b(stop|restart)-computer\b/i.test(c)
  },
  {
    id: 'publish',
    level: 'high',
    reason: 'Publishes to the public, which is hard to take back.',
    test: (c) =>
      /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b/i.test(
        c
      )
  },
  {
    id: 'drop-data',
    level: 'high',
    reason: 'Deletes database tables or data.',
    test: (c) => /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(c)
  },
  {
    id: 'recursive-delete',
    level: 'medium',
    reason: 'Deletes a folder and everything inside it.',
    test: (c) => deletes(c).some((d) => d.recursive)
  }
]

const FILE_RULES: { id: string; level: RiskLevel; reason: string; path: RegExp }[] = [
  {
    id: 'claude-settings',
    level: 'high',
    reason: "Changes Claude Code's own settings or hooks.",
    path: /(^|\/)\.claude\/settings(\.local)?\.json$/i
  },
  { id: 'ssh-keys', level: 'high', reason: 'Touches your SSH keys.', path: /(^|\/)\.ssh\// },
  {
    id: 'git-internals',
    level: 'high',
    reason: 'Changes git config or git hooks, which run code later.',
    path: /(^|\/)\.git\/(config$|hooks\/)/i
  },
  {
    id: 'secrets-file',
    level: 'medium',
    reason: 'Edits a file that usually holds secrets.',
    path: /(^|\/)\.env(\.[\w-]+)?$/i
  }
]

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const FILE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path'
}

/** The most serious rule a tool call trips, or null. */
export function assessRisk(toolName: string, input: Record<string, unknown>): RiskFlag | null {
  if (SHELL_TOOLS.has(toolName)) {
    const command = typeof input.command === 'string' ? input.command : ''
    const rule = SHELL_RULES.find((r) => r.test(command))
    return rule ? { level: rule.level, rule: rule.id, reason: rule.reason } : null
  }
  const key = FILE_TOOLS[toolName]
  if (key) {
    const path = typeof input[key] === 'string' ? (input[key] as string).replace(/\\/g, '/') : ''
    const rule = FILE_RULES.find((r) => r.path.test(path))
    return rule ? { level: rule.level, rule: rule.id, reason: rule.reason } : null
  }
  return null
}
