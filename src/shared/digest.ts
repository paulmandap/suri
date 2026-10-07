import { shorten } from './activity'
import {
  dayTitle,
  linesLabel,
  turnTitle,
  type DecisionView,
  type RecapOutcome,
  type TurnStatus,
  type TurnView
} from './history'

// The daily digest (plan, Phase 6; ADR-022): a day of turns as standup notes.
// Facts come from the history; a model may reword them, but Suri can always
// write a plain version on its own, so the digest works with no model at all.

export interface DigestItem {
  title: string
  status: TurnStatus
  outcome?: RecapOutcome
  summary?: string
  followUps: string[]
}

export interface ProjectFacts {
  name: string
  turns: number
  durationMs: number
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  failedCommands: number
  items: DigestItem[]
}

/** One day of work, counted. What a model gets to reword, and the plain version's source. */
export interface DigestFacts {
  day: string
  turns: number
  projects: ProjectFacts[]
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  approvals: { allowed: number; denied: number }
}

/** What a model writes for the digest. Checked with Zod in main (ai/digest.ts). */
export interface DigestReply {
  headline: string
  projects: { name: string; done: string[]; inProgress: string[] }[]
  blockers: string[]
  next: string[]
}

export interface DigestProject {
  name: string
  done: string[]
  inProgress: string[]
}

export interface Digest {
  day: string
  headline: string
  projects: DigestProject[]
  blockers: string[]
  next: string[]
  /** One line of numbers. */
  stats: string
  /** The model that wrote it. Missing for Suri's own plain version. */
  model?: string
  /** Set when Gemini failed first and the local model answered instead. */
  fellBackFrom?: string
  /** Why this is the plain version, when a model was asked and couldn't answer. */
  note?: string
  /** How many turns it covers, to tell when newer ones came in. */
  turns: number
  createdAt: number
}

const MAX_DONE = 8
const MAX_IN_PROGRESS = 6
const MAX_BLOCKERS = 5
const MAX_NEXT = 6
const ITEM_MAX = 160

/** Turns that did something, by project in the order work started. */
export function buildDigestFacts(
  day: string,
  turns: readonly TurnView[],
  decisions: readonly DecisionView[]
): DigestFacts {
  const projects = new Map<string, ProjectFacts>()
  const facts: DigestFacts = {
    day,
    turns: 0,
    projects: [],
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    approvals: {
      allowed: decisions.filter((d) => d.outcome === 'allow').length,
      denied: decisions.filter((d) => d.outcome === 'deny').length
    }
  }
  const ordered = [...turns].sort((a, b) => a.startedAt - b.startedAt)
  for (const turn of ordered) {
    if (!turn.prompt && !turn.lastMessage && !turn.recap && !(turn.facts?.steps ?? 0)) continue
    let project = projects.get(turn.project)
    if (!project) {
      project = {
        name: turn.project,
        turns: 0,
        durationMs: 0,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        failedCommands: 0,
        items: []
      }
      projects.set(turn.project, project)
    }
    const f = turn.facts
    project.turns++
    project.durationMs += f?.durationMs ?? 0
    project.filesChanged += (f?.filesChanged.length ?? 0) + (f?.moreFiles ?? 0)
    project.linesAdded += f?.linesAdded ?? 0
    project.linesRemoved += f?.linesRemoved ?? 0
    project.failedCommands += f?.commands.filter((c) => c.status === 'failed').length ?? 0
    project.items.push({
      title: turnTitle(turn),
      status: turn.status,
      ...(turn.recap
        ? { outcome: turn.recap.outcome, summary: turn.recap.summary }
        : turn.error
          ? { summary: turn.error }
          : {}),
      followUps: turn.recap?.followUps ?? []
    })
    facts.turns++
  }
  facts.projects = [...projects.values()]
  for (const p of facts.projects) {
    facts.filesChanged += p.filesChanged
    facts.linesAdded += p.linesAdded
    facts.linesRemoved += p.linesRemoved
  }
  return facts
}

/** Where an item goes in the notes. */
function placeOf(item: DigestItem): 'done' | 'inProgress' {
  if (item.outcome) return item.outcome === 'done' ? 'done' : 'inProgress'
  return item.status === 'done' ? 'done' : 'inProgress'
}

/** Why an item holds things up, or null when it doesn't. */
function blockerOf(item: DigestItem): string | null {
  if (item.outcome === 'failed') return `${item.title} (couldn't finish)`
  if (item.outcome === 'needs-input') return `${item.title} (waiting for your answer)`
  if (!item.outcome && item.status === 'error') return `${item.title} (stopped with an error)`
  return null
}

/** Suri's own digest, from the facts alone. Used when no model answers. */
export function plainDigest(facts: DigestFacts, createdAt: number, note?: string): Digest {
  const projects = facts.projects.map((p) => ({
    name: p.name,
    done: unique(
      p.items.filter((i) => placeOf(i) === 'done').map((i) => i.title),
      MAX_DONE
    ),
    inProgress: unique(
      p.items.filter((i) => placeOf(i) === 'inProgress').map((i) => i.title),
      MAX_IN_PROGRESS
    )
  }))
  const items = facts.projects.flatMap((p) => p.items)
  return {
    day: facts.day,
    headline: plainHeadline(facts),
    projects,
    blockers: unique(
      items.map(blockerOf).filter((b): b is string => b !== null),
      MAX_BLOCKERS
    ),
    next: unique(
      items.flatMap((i) => i.followUps),
      MAX_NEXT
    ),
    stats: statsLine(facts),
    ...(note ? { note } : {}),
    turns: facts.turns,
    createdAt
  }
}

/**
 * A model's notes, held to the facts: projects come from the history in its
 * order, and one the model left out (or made up) falls back to the plain lists.
 */
export function digestFromReply(
  facts: DigestFacts,
  reply: DigestReply,
  answered: { model: string; fellBackFrom?: string },
  createdAt: number
): Digest {
  const plain = plainDigest(facts, createdAt)
  const byName = new Map(reply.projects.map((p) => [p.name.trim().toLowerCase(), p]))
  const projects = plain.projects.map((p) => {
    const said = byName.get(p.name.toLowerCase())
    if (!said) return p
    const done = clean(said.done, MAX_DONE)
    const inProgress = clean(said.inProgress, MAX_IN_PROGRESS)
    return done.length + inProgress.length > 0 ? { name: p.name, done, inProgress } : p
  })
  const headline = tidy(reply.headline, 300)
  return {
    ...plain,
    headline: headline || plain.headline,
    projects,
    blockers: clean(reply.blockers, MAX_BLOCKERS),
    next: clean(reply.next, MAX_NEXT),
    model: answered.model,
    ...(answered.fellBackFrom ? { fellBackFrom: answered.fellBackFrom } : {})
  }
}

/** The notes as Markdown, for Copy and Save. */
export function digestMarkdown(digest: Digest): string {
  const lines = [`# Standup notes: ${dayTitle(digest.day)}`, '', digest.headline]
  for (const p of digest.projects) {
    lines.push('', `## ${p.name}`)
    if (p.done.length > 0) lines.push('', '**Done**', ...p.done.map((item) => `- ${item}`))
    if (p.inProgress.length > 0) {
      lines.push('', '**In progress**', ...p.inProgress.map((item) => `- ${item}`))
    }
  }
  if (digest.blockers.length > 0) {
    lines.push('', '## Blockers', '', ...digest.blockers.map((item) => `- ${item}`))
  }
  if (digest.next.length > 0)
    lines.push('', '## Next', '', ...digest.next.map((item) => `- ${item}`))
  lines.push('', '---', '', digest.stats, '', `_${byLine(digest)}_`)
  return lines.join('\n') + '\n'
}

/** Who wrote the notes. */
export function byLine(digest: Pick<Digest, 'model' | 'fellBackFrom'>): string {
  if (!digest.model) return 'Written by Suri from its history, without AI.'
  const fell = digest.fellBackFrom ? ` (Gemini: ${digest.fellBackFrom})` : ''
  return `Written by Suri with ${digest.model}${fell}.`
}

export function statsLine(facts: DigestFacts): string {
  const parts = [plural(facts.turns, 'turn')]
  if (facts.filesChanged > 0) {
    const lines = linesLabel(facts.linesAdded, facts.linesRemoved)
    parts.push(`${plural(facts.filesChanged, 'file')} changed${lines ? ` (${lines})` : ''}`)
  }
  const { allowed, denied } = facts.approvals
  if (allowed + denied > 0) {
    parts.push(`${plural(allowed + denied, 'approval')}: ${allowed} allowed, ${denied} denied`)
  }
  return parts.join(' · ')
}

function plainHeadline(facts: DigestFacts): string {
  if (facts.turns === 0) return 'No Claude Code work recorded on this day.'
  const names = facts.projects.map((p) => p.name)
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const where = names.length === 1 ? 'in' : `across ${names.length} projects:`
  return `${plural(facts.turns, 'turn')} ${where} ${list}.`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** One line, no markdown, a sane length. */
function tidy(text: string, max: number): string {
  return shorten(text.replace(/\*\*|__|`/g, '').replace(/^\s*(?:[-*•]|#+)\s+/, ''), max)
}

function clean(items: readonly string[], max: number): string[] {
  return unique(
    items.map((item) => tidy(item, ITEM_MAX)),
    max
  )
}

/** Non-empty, without repeats (ignoring case), at most `max`. */
function unique(items: readonly string[], max: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = item.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item.trim())
    if (out.length === max) break
  }
  return out
}
