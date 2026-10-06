// Takes secrets out of text before it leaves this PC for a cloud model
// (CLAUDE.md, ADR-015). Pattern-based, so it errs on the side of removing:
// a "max_tokens=100" loses its value too, which costs nothing.

export interface Redacted {
  text: string
  /** How many secrets were removed. */
  count: number
}

const R = '[REDACTED]'

// A key name that marks its value as a secret. `auth` only on its own
// (`auth`, `_auth`, `x-auth`), so `author` and `oauth` stay readable.
const SECRET_NAME = String.raw`(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|(?<![a-z])auth(?![a-z]))`

// Order matters: whole tokens first, so a later "name: value" rule never
// hides just the first word of a value and leaves the rest.
const RULES: { pattern: RegExp; replace: string }[] = [
  // PEM private keys, whole.
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: `${R} private key`
  },
  // user:password@ in a URL (database and git URLs).
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]+@/gi, replace: `$1:${R}@` },
  // An Authorization header (a line, JSON, a curl flag): the credential goes,
  // whatever it looks like. The scheme stays, for context.
  {
    pattern:
      /\b(authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|digest|token)\s+)?)[^\s"',;]+/gi,
    replace: `$1${R}`
  },
  // Bearer … / Basic … elsewhere. A token there has a digit or a symbol, so prose
  // like "Basic configuration" is left alone.
  { pattern: /\b(Bearer|Basic) (?=[\w.~+/=-]*[\d.~+/=-])[\w.~+/=-]{12,}/gi, replace: `$1 ${R}` },
  // Well-known token shapes.
  { pattern: /\bsk-ant-[\w-]{20,}/g, replace: R },
  { pattern: /\bsk-(?:proj-|live-|test-)?[\w-]{20,}/g, replace: R },
  { pattern: /\b(?:sk|rk)_(?:live|test)_\w{16,}/g, replace: R },
  { pattern: /\bAIza[\w-]{35}/g, replace: R },
  // Newer Google AI Studio keys (seen 2026-10-06).
  { pattern: /\bAQ\.[\w-]{40,}/g, replace: R },
  { pattern: /\bgh[pousr]_\w{30,}/g, replace: R },
  { pattern: /\bgithub_pat_\w{20,}/g, replace: R },
  { pattern: /\bxox[abposr]-[\w-]{10,}/g, replace: R },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: R },
  { pattern: /\bnpm_\w{36}\b/g, replace: R },
  { pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, replace: R },
  // "apiKey": "…" in JSON, or a number such as a PIN.
  {
    pattern: new RegExp(
      String.raw`("[^"\n]*${SECRET_NAME}[^"\n]*"\s*:\s*)(?:"(?:[^"\\\n]|\\.)*"|-?\d[\w.+-]*)`,
      'gi'
    ),
    replace: `$1"${R}"`
  },
  // API_KEY=…, password: …, --token=… (.env files, YAML, command lines). A
  // header the Bearer rule already handled counts as one value, not two.
  {
    pattern: new RegExp(
      String.raw`\b([\w.-]*${SECRET_NAME}[\w.-]*)(\s*[:=]\s*)(?:(?:Bearer|Basic) \[REDACTED\]|"[^"\n]*"|'[^'\n]*'|[^\s"',;]+)`,
      'gi'
    ),
    replace: `$1$2${R}`
  }
]

/**
 * Removes secrets from text. `known` are exact values that must never leave
 * (Suri's hook token, the Gemini key itself); the rules catch the rest.
 */
export function redactSecrets(text: string, known: readonly string[] = []): Redacted {
  let count = 0
  let out = text
  for (const secret of known) {
    // Short values would match ordinary words.
    if (secret.length < 8) continue
    const parts = out.split(secret)
    count += parts.length - 1
    out = parts.join(R)
  }
  for (const { pattern, replace } of RULES) {
    const single = new RegExp(pattern.source, pattern.flags.replace('g', ''))
    out = out.replace(pattern, (match: string) => {
      // Nothing left to hide: an earlier rule (or an earlier pass) took it.
      if (match.includes(R)) return match
      count++
      return match.replace(single, replace)
    })
  }
  return { text: out, count }
}
