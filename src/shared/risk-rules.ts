import type { RiskFlag, RiskLevel } from './types'

// The safety net's rules (ADR-007, ADR-016). Instant and deterministic: they
// run on every tool call, so no model and no I/O. Only `high` forces a prompt;
// `medium` is shown on the approval card for context. The AI explainer adds a
// plain-English explanation on top, but it can never lower what a rule says.

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }

/** The more serious of two levels. */
export function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return ORDER[a] >= ORDER[b] ? a : b
}

interface Rule {
  id: string
  level: RiskLevel
  reason: string
  test: (command: string) => boolean
}

// Delete commands across bash, PowerShell (incl. its aliases) and cmd.
const DELETE = /(?:^|[\s;&|(])(rm|rmdir|rd|del|erase|ri|remove-item)\b([^;&|\n]*)/gi

// PowerShell parameters with an "r" in them that don't mean recursive, as typed
// in full or shortened (PowerShell accepts any unique prefix).
const NOT_RECURSIVE = [
  '-force',
  '-filter',
  '-literalpath',
  '-erroraction',
  '-credential',
  '-verbose',
  '-stream'
]

/** `-r`, `-rf`, `-Recurse` (or a prefix of it), `--recursive`, cmd's `/s`. */
function isRecursiveFlag(token: string): boolean {
  const flag = token.toLowerCase()
  if (flag === '--recursive' || flag === '/s') return true
  if (flag.length >= 2 && '-recurse'.startsWith(flag)) return true
  // A bundle of short bash flags, like -rf or -fR.
  return (
    /^-[a-z]{1,4}$/.test(flag) &&
    flag.includes('r') &&
    !NOT_RECURSIVE.some((param) => param.startsWith(flag))
  )
}

// What a recursive delete must never aim at: the filesystem root, a whole
// drive, a home folder, Windows' own folders, or "everything here".
const BROAD_TARGET = new RegExp(
  String.raw`(^|\s)(["']?)(` +
    [
      String.raw`\/\*?`,
      String.raw`~(?:[\\/]\*?)?`,
      String.raw`(?:\$home|\$\{home\}|\$env:userprofile|%userprofile%)(?:[\\/]\*?)?`,
      String.raw`(?:\$env:systemroot|%systemroot%|\$env:windir|%windir%)(?:[\\/]\*?)?`,
      String.raw`\*`,
      String.raw`\.(?:[\\/]\*?)?`,
      String.raw`\.\.`,
      String.raw`[a-z]:(?:[\\/]\*?)?`,
      String.raw`[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata)[\\/]?\*?`,
      // C:\Users, or one person's home folder in it.
      String.raw`[a-z]:[\\/]users(?:[\\/][^\\/\s"']+)?[\\/]?\*?`,
      // Git Bash drives (/c) and the Linux system folders.
      String.raw`\/[a-z]\/?`,
      String.raw`\/[a-z]\/users(?:\/[^\/\s"']+)?\/?`,
      String.raw`\/(?:usr|etc|home|var|bin|boot|lib|opt|root)\/?`
    ].join('|') +
    String.raw`)\2(?=\s|$)`,
  'i'
)

function deletes(command: string): { recursive: boolean; broad: boolean }[] {
  const found: { recursive: boolean; broad: boolean }[] = []
  for (const match of command.matchAll(DELETE)) {
    const args = match[2] ?? ''
    found.push({
      recursive: args.split(/\s+/).some(isRecursiveFlag),
      broad: BROAD_TARGET.test(args)
    })
  }
  return found
}

/** `git restore .` throws away changes in the whole tree, unless it only unstages. */
function restoresWholeTree(command: string): boolean {
  for (const match of command.matchAll(/\bgit\s+restore\b([^;&|\n]*)/gi)) {
    const args = match[1] ?? ''
    const staged = /\s(--staged|-S)\b/.test(args)
    const worktree = /\s(--worktree|-W)\b/.test(args)
    if (/\s\.(?=\s|$)/.test(args) && (!staged || worktree)) return true
  }
  return false
}

/** Environment variables set for good (`setx`, or .NET with a User or Machine target), lowercase. */
function persistentVariables(command: string): string[] {
  const names: string[] = []
  for (const match of command.matchAll(/\bsetx(?:\.exe)?\s+(?:\/m\s+)?["']?(\w+)/gi)) {
    names.push((match[1] ?? '').toLowerCase())
  }
  // The value may hold ";" (PATH does), so look to the end of the line for the target.
  const dotnet =
    /\[(?:system\.)?environment\]::setenvironmentvariable\(\s*["'](\w+)["'][^\n]*?\b(?:user|machine)\b/gi
  for (const match of command.matchAll(dotnet)) names.push((match[1] ?? '').toLowerCase())
  return names
}

// A secret file named in a command: .env files (not the shared examples),
// private SSH keys, stored logins and key files.
const SECRET_FILE_ARG =
  /(^|[\s"'=\\/])(\.env(\.(?!example\b|sample\b|template\b|dist\b)[\w-]+)?|id_(rsa|ed25519|ecdsa|dsa)|\.git-credentials|[._]netrc|\.aws[\\/]credentials|[\w.-]+\.(pem|key|pfx|p12))(?=$|[\s"';|&)])/i
const READERS =
  /\b(cat|type|more|less|head|tail|bat|gc|get-content|select-string|findstr|grep)\b([^;&|\n]*)/gi

function showsSecrets(command: string): boolean {
  for (const match of command.matchAll(READERS)) {
    if (SECRET_FILE_ARG.test(match[2] ?? '')) return true
  }
  // Every environment variable at once, secrets included.
  return (
    /(^|[;&|\n]\s*)(printenv|env|set)\s*($|[;&|\n])/i.test(command) ||
    /\b(gci|ls|dir|get-childitem)\s+env:(?!\w)/i.test(command)
  )
}

const SHELL_RULES: Rule[] = [
  {
    id: 'wide-delete',
    level: 'high',
    reason: 'Deletes a drive, a home or Windows folder, or everything here.',
    test: (c) => deletes(c).some((d) => d.recursive && d.broad)
  },
  {
    id: 'pipe-to-shell',
    level: 'high',
    reason: 'Downloads a script from the internet and runs it straight away.',
    test: (c) =>
      /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?((ba|z|da)?sh|python3?|node|pwsh|powershell)\b/i.test(
        c
      ) ||
      /\b(ba|z)?sh\s+(-c\s+["']?\$\(|<\(\s*)(curl|wget)\b/i.test(c) ||
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
    reason: 'Overwrites or deletes commits on the remote.',
    test: (c) =>
      /\bgit\s+push\b[^;&|\n]*\s(--force(?!-with-lease|-if-includes)|-f|--mirror|--delete|-d)(?=\s|$)/i.test(
        c
      ) ||
      // A "+" refspec forces, and an empty source (":branch") deletes.
      /\bgit\s+push\b[^;&|\n]*\s\+[\w./-]+/i.test(c) ||
      /\bgit\s+push\s+\S+\s+:[\w./-]+/i.test(c)
  },
  {
    id: 'discard-work',
    level: 'high',
    reason: 'Throws away uncommitted work for good.',
    test: (c) =>
      /\bgit\s+reset\b[^;&|\n]*\s--hard\b/i.test(c) ||
      /\bgit\s+clean\s+-[a-z]*f/i.test(c) ||
      /\bgit\s+checkout\s+(--\s+)?\.(?=\s|$)/i.test(c) ||
      restoresWholeTree(c) ||
      /\bgit\s+stash\s+clear\b/i.test(c)
  },
  {
    id: 'disk-or-system',
    level: 'high',
    reason: 'Changes disks or how Windows starts.',
    test: (c) =>
      /\b(format(\.com)?\s+[a-z]:|diskpart|mkfs(\.\w+)?\b|bcdedit)/i.test(c) ||
      /\bdd\b[^;&|\n]*\bof=\/dev\//i.test(c) ||
      /\b(format-volume|clear-disk|initialize-disk|remove-partition)\b/i.test(c)
  },
  {
    id: 'registry-edit',
    level: 'high',
    reason: 'Changes the Windows registry.',
    test: (c) =>
      /\breg(\.exe)?\s+(add|delete|import|copy|restore|load|unload)\b/i.test(c) ||
      /\bregedit(\.exe)?\b[^;&|\n]*\s\/s\b/i.test(c) ||
      /\b(set|new|remove|rename|clear)-item(property)?\b[^;&|\n]*\b(hk(lm|cu|cr|u|cc)|registry):/i.test(
        c
      )
  },
  {
    id: 'path-overwrite',
    level: 'high',
    reason: 'Rewrites PATH for good, which can break other programs.',
    test: (c) => persistentVariables(c).includes('path')
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
    reason: 'Publishes or unpublishes a package, which is hard to take back.',
    test: (c) =>
      /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/i.test(c) ||
      /\b(cargo|poetry|uv|flit|vsce)\s+publish\b|\bgem\s+push\b|\bdotnet\s+nuget\s+push\b/i.test(
        c
      ) ||
      /\btwine\s+upload\b|\bgh\s+release\s+create\b/i.test(c)
  },
  {
    id: 'drop-data',
    level: 'high',
    reason: 'Deletes a database, its tables or all of their rows.',
    test: (c) =>
      /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(c) ||
      // DELETE FROM with no WHERE empties the table.
      /\bdelete\s+from\s+[\w.`"[\]]+?\s*(;|["']?\s*($|[;&|]))/im.test(c) ||
      /\b(dropdb|flushall|flushdb)\b|\bprisma\s+migrate\s+reset\b|\b(db:drop|db:reset|migrate:fresh)\b/i.test(
        c
      )
  },
  {
    id: 'recursive-delete',
    level: 'medium',
    reason: 'Deletes a folder and everything inside it.',
    test: (c) => deletes(c).some((d) => d.recursive)
  },
  {
    id: 'read-secrets',
    level: 'medium',
    reason: 'Shows secret values (keys or passwords) to the agent.',
    test: showsSecrets
  },
  {
    id: 'git-delete',
    level: 'medium',
    reason: "Deletes a branch or a stash, even if its work isn't merged.",
    test: (c) => /\bgit\s+branch\b[^;&|\n]*\s-D\b/.test(c) || /\bgit\s+stash\s+drop\b/i.test(c)
  },
  {
    id: 'global-install',
    level: 'medium',
    reason: 'Installs software for the whole PC, not just this project.',
    test: (c) =>
      /\b(npm|pnpm)\s+(i|install|add)\b[^;&|\n]*\s(-g|--global)(?=\s|$)/i.test(c) ||
      /\byarn\s+global\s+add\b|\b(winget|choco|scoop)\s+install\b|\binstall-(module|package|script)\b/i.test(
        c
      )
  },
  {
    id: 'env-persist',
    level: 'medium',
    reason: 'Sets an environment variable for good, for every new program.',
    test: (c) => persistentVariables(c).length > 0
  }
]

interface PathRule {
  id: string
  level: RiskLevel
  reason: string
  /** Matched against the path in lowercase, with forward slashes. */
  path: RegExp
}

// Not the .env.example kind, which is meant to be shared.
const ENV_FILE = String.raw`\.env(\.(?!example$|sample$|template$|dist$)[\w-]+)?`
const LOGIN_FILE = String.raw`\.git-credentials|[._]netrc|\.aws\/credentials|\.docker\/config\.json|\.kube\/config`
const KEY_FILE = String.raw`[\w.-]+\.(pem|key|pfx|p12)`

// Edit, Write and friends. The most serious first: the first match wins.
const WRITE_RULES: PathRule[] = [
  {
    id: 'claude-settings',
    level: 'high',
    reason: "Changes Claude Code's own settings or hooks.",
    path: /(^|\/)\.claude\/settings(\.local)?\.json$/
  },
  { id: 'ssh-keys', level: 'high', reason: 'Touches your SSH keys.', path: /(^|\/)\.ssh\// },
  {
    id: 'git-internals',
    level: 'high',
    reason: 'Changes git config or git hooks, which run code later.',
    path: /(^|\/)\.git\/(config$|hooks\/)/
  },
  {
    id: 'credentials-file',
    level: 'high',
    reason: 'Changes a file that stores login credentials.',
    path: new RegExp(String.raw`(^|\/)(${LOGIN_FILE})$`)
  },
  {
    id: 'secrets-file',
    level: 'medium',
    reason: 'Edits a file that usually holds secrets.',
    path: new RegExp(
      String.raw`(^|\/)(${ENV_FILE}|\.npmrc|\.pypirc|secrets?\.(json|ya?ml)|credentials\.json|${KEY_FILE})$`
    )
  }
]

const OUTSIDE_PROJECT = {
  id: 'outside-project',
  level: 'medium',
  reason: 'Changes a file outside this project.'
} as const

// Reading is harmless on its own, but the contents go to the agent (and its AI service).
const READ_RULES: PathRule[] = [
  {
    id: 'read-secrets',
    level: 'medium',
    reason: 'Shows secret values (keys or passwords) to the agent.',
    path: new RegExp(String.raw`(^|\/)(\.ssh\/id_[a-z0-9]+|${LOGIN_FILE}|${ENV_FILE}|${KEY_FILE})$`)
  }
]

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const WRITE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path'
}

/**
 * The most serious rule a tool call trips, or null. `cwd` is the project
 * folder; without it, "outside this project" can't be judged and is skipped.
 */
export function assessRisk(
  toolName: string,
  input: Record<string, unknown>,
  cwd = ''
): RiskFlag | null {
  if (SHELL_TOOLS.has(toolName)) {
    const command = text(input.command)
    return flag(SHELL_RULES.find((r) => r.test(command)))
  }
  const key = WRITE_TOOLS[toolName]
  if (key) {
    const path = text(input[key])
    if (!path) return null
    const rule = WRITE_RULES.find((r) => r.path.test(normalizePath(path)))
    if (rule) return flag(rule)
    return cwd && isOutside(path, cwd) ? flag(OUTSIDE_PROJECT) : null
  }
  if (toolName === 'Read') {
    const path = text(input.file_path)
    return path ? flag(READ_RULES.find((r) => r.path.test(normalizePath(path)))) : null
  }
  return null
}

function flag(rule: Pick<Rule, 'id' | 'level' | 'reason'> | undefined): RiskFlag | null {
  return rule ? { level: rule.level, rule: rule.id, reason: rule.reason } : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Lowercase with forward slashes, `.` and `..` resolved. Git Bash's `/c/…` becomes `c:/…`. */
function normalizePath(path: string): string {
  const p = path
    .replace(/\\/g, '/')
    .replace(/^\/([a-z])(?=\/|$)/i, '$1:')
    .toLowerCase()
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // Never climb above a drive.
      const top = parts[parts.length - 1]
      if (top !== undefined && !/^[a-z]:$/.test(top)) parts.pop()
      continue
    }
    parts.push(part)
  }
  return (p.startsWith('/') ? '/' : '') + parts.join('/')
}

function isOutside(path: string, cwd: string): boolean {
  const absolute = /^(?:[a-z]:)?[\\/]/i.test(path)
  const file = normalizePath(absolute ? path : `${cwd}/${path}`)
  const base = normalizePath(cwd)
  const prefix = base.endsWith('/') ? base : `${base}/`
  if (file === base || file.startsWith(prefix)) return false
  // Scratch files in the temp folder are routine.
  return !/\/appdata\/local\/temp\/|^\/tmp\//.test(file)
}
