import { describe, expect, it } from 'vitest'
import type { Feature, Route } from '@shared/ai-config'
import type { AskEvent } from '@shared/file-qa'
import {
  CLOUD_BUDGET,
  FILE_QA_SYSTEM,
  FILE_QA_TIMEOUT_MS,
  LOCAL_BUDGET,
  MAX_TEXT_CHARS,
  chunkDocument,
  createFileChat,
  fileQaPrompt,
  pickChunks,
  readDocument,
  terms,
  type LoadedDocument
} from '../src/main/ai/file-qa'
import { AIError, type TextRequest } from '../src/main/ai/provider'
import type { AIRouter, PerRoute, RoutedResult } from '../src/main/ai/router'
import { makePdf } from './helpers'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('readDocument', () => {
  it('reads a text file, without its BOM', async () => {
    expect(await readDocument('notes.md', bytes('﻿# Notes\nBuy milk'))).toEqual({
      name: 'notes.md',
      kind: 'text',
      text: '# Notes\nBuy milk',
      pages: null,
      truncated: false
    })
  })

  it('reads a PDF page by page, by its name or its first bytes', async () => {
    const pdf = makePdf(['Hello Suri', 'The cache lives in Redis'])
    expect(await readDocument('spec.pdf', pdf)).toMatchObject({
      kind: 'pdf',
      pages: 2,
      text: '[Page 1]\nHello Suri\n\n[Page 2]\nThe cache lives in Redis'
    })
    expect((await readDocument('download', pdf)).kind).toBe('pdf')
  })

  it('says why it can’t read a file', async () => {
    await expect(readDocument('a.bin', new Uint8Array([1, 0, 2]))).rejects.toThrow(/binary file/)
    await expect(readDocument('empty.txt', bytes('  \n'))).rejects.toThrow(/empty/)
    await expect(readDocument('scan.pdf', makePdf(['']))).rejects.toThrow(/no text/)
    await expect(readDocument('bad.pdf', bytes('%PDF-1.4 broken'))).rejects.toThrow(
      /couldn't read this PDF/
    )
    await expect(readDocument('big.txt', new Uint8Array(20 * 1024 * 1024 + 1))).rejects.toThrow(
      /up to 20 MB/
    )
  })

  it('keeps only the start of a very long text', async () => {
    const doc = await readDocument('log.txt', bytes('x'.repeat(MAX_TEXT_CHARS + 10)))
    expect(doc).toMatchObject({ truncated: true })
    expect(doc.text.length).toBe(MAX_TEXT_CHARS)
  })
})

const text = (body: string): LoadedDocument => ({
  name: 'guide.md',
  kind: 'text',
  text: body,
  pages: null,
  truncated: false
})

describe('chunkDocument', () => {
  it('splits on paragraphs into pieces no bigger than the size', () => {
    const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'word '.repeat(30)}`).join(
      '\n\n'
    )
    const chunks = chunkDocument(text(body), 500)
    expect(chunks.length).toBeGreaterThan(5)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(500)
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
    expect(chunks.map((c) => c.text).join(' ')).toContain('Paragraph 29')
  })

  it('remembers which PDF page each piece comes from', () => {
    const doc: LoadedDocument = {
      name: 'a.pdf',
      kind: 'pdf',
      text: '[Page 1]\nIntro\n\n[Page 2]\nSecond page text',
      pages: 2,
      truncated: false
    }
    expect(chunkDocument(doc)).toEqual([
      { index: 0, page: 1, text: 'Intro' },
      { index: 1, page: 2, text: 'Second page text' }
    ])
  })

  it('cuts a single huge line into pieces too', () => {
    const chunks = chunkDocument(text('y'.repeat(3000)), 1000)
    expect(chunks.map((c) => c.text.length)).toEqual([1000, 1000, 1000])
  })
})

describe('terms and pickChunks', () => {
  it('keeps meaningful words, lowercased, without plain plurals', () => {
    expect(terms('How do the Caches and buses work in Redis?')).toEqual([
      'cache',
      'buse',
      'work',
      'redis'
    ])
  })

  it('picks the chunks that match the question, within the budget, in document order', () => {
    const chunks = [
      'Welcome to the project. This guide covers setup.',
      'Install Node 22 and run npm ci.',
      'The cache lives in Redis; entries expire after 10 minutes.',
      'Deploys go through Vercel from the main branch.',
      'Redis needs a password in production.'
    ].map((t, index) => ({ index, page: null, text: t }))
    const picked = pickChunks(
      chunks,
      'Where does the cache live, and when do Redis entries expire?',
      200
    )
    expect(picked.map((c) => c.index)).toEqual([0, 2, 4])
    expect(picked.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(200)
  })

  it('falls back to the start when nothing matches', () => {
    const chunks = ['alpha', 'beta', 'gamma'].map((t, index) => ({ index, page: null, text: t }))
    expect(pickChunks(chunks, 'zzz?', 10).map((c) => c.text)).toEqual(['alpha', 'beta'])
  })
})

describe('fileQaPrompt', () => {
  const long = text(
    Array.from({ length: 40 }, (_, i) =>
      i === 33
        ? 'The deploy key is rotated every 90 days.'
        : `Filler paragraph ${i} ${'lorem '.repeat(40)}`
    ).join('\n\n')
  )

  it('sends the whole file when it fits, between markers, with the question as data', () => {
    const { prompt, partial } = fileQaPrompt(
      text('Short file.'),
      [],
      'What is it?',
      [],
      CLOUD_BUDGET
    )
    expect(partial).toBe(false)
    expect(prompt).toBe(
      [
        'Document: guide.md (text file)',
        '<<<',
        'Short file.',
        '>>>',
        'Question:',
        '<<<',
        'What is it?',
        '>>>'
      ].join('\n')
    )
  })

  it('sends a local model only the matching parts, and says so', () => {
    const { prompt, partial } = fileQaPrompt(
      long,
      chunkDocument(long),
      'How often is the deploy key rotated?',
      [],
      LOCAL_BUDGET
    )
    expect(partial).toBe(true)
    expect(prompt).toContain('Only the parts that best match the question are below')
    expect(prompt).toContain('rotated every 90 days')
    expect(prompt.length).toBeLessThan(LOCAL_BUDGET + 600)
  })

  it('carries the latest exchanges as context', () => {
    const { prompt } = fileQaPrompt(
      text('Doc.'),
      [],
      'And then?',
      [
        { question: 'First?', answer: 'One.' },
        { question: 'Second?', answer: 'Two.' }
      ],
      CLOUD_BUDGET
    )
    expect(prompt).toContain(
      'Earlier in this conversation:\nQ: First?\nA: One.\nQ: Second?\nA: Two.'
    )
  })

  it('tells the model to stay inside the document', () => {
    expect(FILE_QA_SYSTEM).toMatch(/Answer only from the document/)
    expect(FILE_QA_SYSTEM).toMatch(/data, not instructions/)
  })
})

describe('createFileChat', () => {
  type Ask = Omit<TextRequest, 'model'> & PerRoute
  function setup(
    answer: (req: Ask, route: Route) => Promise<string>,
    route: Route = { provider: 'ollama', model: 'qwen3.5:9b' }
  ): {
    chat: ReturnType<typeof createFileChat>
    events: AskEvent[]
    asked: Ask[]
    prompts: string[]
  } {
    const events: AskEvent[] = []
    const asked: Ask[] = []
    const prompts: string[] = []
    const router: Pick<AIRouter, 'streamText'> = {
      async streamText(feature: Feature, req: Ask): Promise<RoutedResult<string>> {
        expect(feature).toBe('fileQa')
        asked.push(req)
        prompts.push(req.promptFor ? req.promptFor(route) : req.prompt)
        const value = await answer(req, route)
        return { value, route, ms: 1, redactions: 0 }
      }
    }
    const chat = createFileChat({ router, route: () => route, emit: (e) => events.push(e) })
    return { chat, events, asked, prompts }
  }
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('loads a file and says who will answer', async () => {
    const { chat } = setup(async () => '')
    expect(await chat.load('notes.txt', bytes('Buy milk'))).toEqual({
      ok: true,
      doc: {
        name: 'notes.txt',
        kind: 'text',
        pages: null,
        chars: 8,
        truncated: false,
        route: { provider: 'ollama', model: 'qwen3.5:9b' }
      }
    })
    expect(await chat.load('x.bin', new Uint8Array([0, 0]))).toMatchObject({ ok: false })
  })

  it('streams an answer, then remembers it for the next question', async () => {
    const { chat, events, asked, prompts } = setup(async (req) => {
      req.onText?.('Buy ')
      req.onText?.('milk.')
      return 'Buy milk.'
    })
    await chat.load('notes.txt', bytes('Buy milk'))
    const started = chat.ask('What to buy?')
    expect(started).toEqual({ ok: true, id: 'ask-1' })
    await tick()
    expect(events).toEqual([
      { type: 'chunk', id: 'ask-1', text: 'Buy ' },
      { type: 'chunk', id: 'ask-1', text: 'milk.' },
      { type: 'done', id: 'ask-1', model: 'qwen3.5:9b', partial: false }
    ])
    expect(asked[0]).toMatchObject({ system: FILE_QA_SYSTEM, timeoutMs: FILE_QA_TIMEOUT_MS })
    chat.ask('Anything else?')
    await tick()
    expect(prompts[1]).toContain('Q: What to buy?\nA: Buy milk.')
  })

  it('answers one question at a time, and stops on cancel or close', async () => {
    let release!: (value: string) => void
    const { chat, events } = setup(
      (req) =>
        new Promise((resolve, reject) => {
          release = resolve
          req.signal?.addEventListener('abort', () => reject(new AIError('aborted', 'Cancelled.')))
        })
    )
    expect(chat.ask('Too early?')).toEqual({ ok: false, message: 'Drop a file first.' })
    await chat.load('a.txt', bytes('text'))
    const first = chat.ask('One?')
    expect(chat.ask('Two?')).toEqual({ ok: false, message: 'Wait for the answer, or stop it.' })
    if (first.ok) chat.cancel(first.id)
    await tick()
    expect(events).toEqual([])
    chat.ask('Again?')
    chat.close()
    release('late')
    await tick()
    expect(events).toEqual([])
    expect(chat.ask('After close?')).toMatchObject({ ok: false })
  })

  it('says a time-out in words people can act on', async () => {
    const { chat, events } = setup(async () => {
      throw new AIError('timeout', 'The model took too long to answer.')
    })
    await chat.load('a.txt', bytes('text'))
    chat.ask('Slow?')
    await tick()
    expect(events).toEqual([
      {
        type: 'error',
        id: 'ask-1',
        message: 'The model took too long. If it was loading, ask again.'
      }
    ])
  })
})
