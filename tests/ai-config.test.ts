import { describe, expect, it } from 'vitest'
import {
  applyAiPatch,
  attemptsFor,
  canFallBack,
  DEFAULT_AI,
  isLoopbackUrl,
  isValidModel,
  type AIErrorKind
} from '@shared/ai-config'

describe('isLoopbackUrl', () => {
  it.each([
    'http://127.0.0.1:11434',
    'http://localhost:11434/',
    'http://[::1]:11434',
    'https://127.0.0.1:8443'
  ])('accepts %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(true)
  })

  it.each([
    'http://192.168.1.5:11434',
    'http://example.com:11434',
    'http://127.0.0.1.evil.example:11434',
    'http://127.0.0.1:11434/api',
    'http://127.0.0.1:11434/?x=1',
    'http://127.0.0.1:11434/#x',
    'http://user:pw@127.0.0.1:11434',
    'ftp://127.0.0.1',
    'file:///C:/ollama',
    'not a url',
    ''
  ])('rejects %j', (url) => {
    expect(isLoopbackUrl(url)).toBe(false)
  })
})

describe('isValidModel', () => {
  it.each(['qwen3.5:9b', 'qwen2.5:7b-instruct', 'hf.co/someone/repo:Q4_K_M', 'llama3'])(
    'accepts the Ollama model %s',
    (model) => {
      expect(isValidModel('ollama', model)).toBe(true)
    }
  )

  it.each(['', 'two words', '../etc', '-rf', 'model;rm', 'a'.repeat(129)])(
    'rejects the Ollama model %j',
    (model) => {
      expect(isValidModel('ollama', model)).toBe(false)
    }
  )

  it('takes Gemini ids that can safely go into a URL path, nothing else', () => {
    expect(isValidModel('gemini', 'gemini-3.8-flash')).toBe(true)
    expect(isValidModel('gemini', 'gemini-2.5-flash-lite')).toBe(true)
    for (const bad of [
      'models/gemini-3.8-flash',
      'gemini:flash',
      'Gemini-3',
      'gemini 3',
      '../x',
      ''
    ]) {
      expect(isValidModel('gemini', bad)).toBe(false)
    }
  })
})

describe('routing', () => {
  it('keeps frequent and sensitive features local by default (ADR-004)', () => {
    expect(DEFAULT_AI.routes.risk.provider).toBe('ollama')
    expect(DEFAULT_AI.routes.recap.provider).toBe('ollama')
    expect(DEFAULT_AI.routes.fileQa.provider).toBe('gemini')
    expect(DEFAULT_AI.routes.digest.provider).toBe('gemini')
  })

  it('tries a local route alone', () => {
    expect(attemptsFor('risk', DEFAULT_AI)).toEqual([{ provider: 'ollama', model: 'qwen3.5:9b' }])
  })

  it('uses one local model for every local feature, so it stays warm (ADR-023)', () => {
    expect(DEFAULT_AI.routes.risk.model).toBe('qwen3.5:9b')
    expect(DEFAULT_AI.routes.recap.model).toBe('qwen3.5:9b')
    expect(DEFAULT_AI.fallbackModel).toBe('qwen3.5:9b')
  })

  it('puts the local fallback model behind a Gemini route, never the other way', () => {
    const ai = { ...DEFAULT_AI, fallbackModel: 'qwen2.5:7b-instruct' }
    expect(attemptsFor('fileQa', ai)).toEqual([
      { provider: 'gemini', model: 'gemini-3.8-flash' },
      { provider: 'ollama', model: 'qwen2.5:7b-instruct' }
    ])
    for (const route of attemptsFor('risk', ai)) expect(route.provider).toBe('ollama')
  })

  it('falls back on every failure except a cancel', () => {
    const kinds: AIErrorKind[] = [
      'offline',
      'rate-limit',
      'auth',
      'no-key',
      'not-found',
      'timeout',
      'bad-output',
      'unavailable',
      'other'
    ]
    for (const kind of kinds) expect(canFallBack(kind)).toBe(true)
    expect(canFallBack('aborted')).toBe(false)
  })
})

describe('applyAiPatch', () => {
  it('changes only what the patch names, and leaves the input alone', () => {
    const before = JSON.stringify(DEFAULT_AI)
    const next = applyAiPatch(DEFAULT_AI, {
      route: { feature: 'digest', provider: 'ollama', model: 'qwen2.5:7b-instruct' }
    })
    expect(next.routes.digest).toEqual({ provider: 'ollama', model: 'qwen2.5:7b-instruct' })
    expect(next.routes.fileQa).toEqual(DEFAULT_AI.routes.fileQa)
    expect(next.ollamaUrl).toBe(DEFAULT_AI.ollamaUrl)
    expect(JSON.stringify(DEFAULT_AI)).toBe(before)

    expect(applyAiPatch(DEFAULT_AI, { ollamaUrl: 'http://localhost:11500' }).ollamaUrl).toBe(
      'http://localhost:11500'
    )
    expect(applyAiPatch(DEFAULT_AI, { fallbackModel: 'llama3' }).fallbackModel).toBe('llama3')
  })
})
