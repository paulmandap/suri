import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHookEvent, type HookEvent } from '@shared/hook-events'

/** A captured payload from tests/fixtures/hooks, as raw JSON. */
export function fixture(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests', 'fixtures', 'hooks', `${name}.json`)
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/**
 * A minimal PDF with one line of text per page, built by hand so tests need
 * no PDF tool. Each page is Helvetica text; the xref offsets are counted.
 */
export function makePdf(pages: string[]): Uint8Array {
  const escape = (text: string): string => text.replace(/([\\()])/g, '\\$1')
  const objects: string[] = []
  const pageIds = pages.map((_, i) => 4 + i * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${escape(text)}) Tj ET`
    objects[pageIds[i]!] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`
    objects[pageIds[i]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** A fixture (or a hand-made payload) parsed into a HookEvent, with overrides. */
export function hookEvent(
  nameOrPayload: string | Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): HookEvent {
  const base = typeof nameOrPayload === 'string' ? fixture(nameOrPayload) : nameOrPayload
  const parsed = parseHookEvent({ ...base, ...overrides })
  if (!parsed.ok) throw new Error(`test payload rejected: ${JSON.stringify(parsed)}`)
  return parsed.event
}
