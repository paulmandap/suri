import { describe, expect, it } from 'vitest'
import { redactSecrets } from '@shared/redact'

const R = '[REDACTED]'

/** Each case: the text, and a secret part that must not survive. */
const TOKENS: [string, string][] = [
  ['Anthropic', `key sk-ant-api03-${'a'.repeat(40)} here`],
  ['OpenAI project', `key sk-proj-${'b'.repeat(30)} here`],
  ['Google', `key AIza${'c'.repeat(35)} here`],
  ['Google, newer format', `key AQ.Ab${'c'.repeat(47)} here`],
  ['GitHub', `key ghp_${'d'.repeat(36)} here`],
  ['GitHub fine-grained', `key github_pat_${'e'.repeat(40)} here`],
  ['Slack', 'key xoxb-1234567890-abcdefghij here'],
  ['AWS', 'key AKIAABCDEFGHIJKLMNOP here'],
  ['npm', `key npm_${'f'.repeat(36)} here`],
  [
    'JWT',
    'key eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U here'
  ]
]

describe('redactSecrets', () => {
  it.each(TOKENS)('removes a %s token', (_name, text) => {
    const result = redactSecrets(text)
    expect(result.text).toBe(`key ${R} here`)
    expect(result.count).toBe(1)
  })

  it('removes known values exactly, but ignores very short ones', () => {
    const result = redactSecrets('token abcdefgh12345678 and abc', ['abcdefgh12345678', 'abc'])
    expect(result.text).toBe(`token ${R} and abc`)
    expect(result.count).toBe(1)
  })

  it('removes a whole private key', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nqwerty\n-----END RSA PRIVATE KEY-----'
    const result = redactSecrets(`before\n${pem}\nafter`)
    expect(result.text).toBe(`before\n${R} private key\nafter`)
    expect(result.text).not.toContain('MIIE')
  })

  it('keeps the user but not the password of a URL', () => {
    const result = redactSecrets('DATABASE_URL is postgres://admin:s3cret@db.example.com:5432/app')
    expect(result.text).toBe(`DATABASE_URL is postgres://admin:${R}@db.example.com:5432/app`)
  })

  it.each([
    ['Authorization: Bearer abc123def456ghi789', `Authorization: Bearer ${R}`],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', `Authorization: Basic ${R}`],
    [
      'curl -H "Authorization: Bearer abc123def456ghi789" x',
      `curl -H "Authorization: Bearer ${R}" x`
    ],
    // The scheme's case doesn't matter in HTTP, and a credential may be letters only.
    ['authorization: bearer abc123DEF456ghi789', `authorization: bearer ${R}`],
    ['Authorization: Basic dXNlcjpwYXNz', `Authorization: Basic ${R}`],
    ['{"Authorization": "Bearer abc123def456ghi789"}', `{"Authorization": "Bearer ${R}"}`],
    ['Authorization: abc123def456ghi789', `Authorization: ${R}`]
  ])('leaves no part of an Authorization header: %s', (text, expected) => {
    const result = redactSecrets(text)
    expect(result.text).toBe(expected)
    expect(result.count).toBe(1)
  })

  it('leaves prose about bearers and basics alone', () => {
    for (const text of [
      'Basic configuration is enough.',
      'Bearer of bad news',
      'Uses 1200 tokens'
    ]) {
      expect(redactSecrets(text)).toEqual({ text, count: 0 })
    }
  })

  it('removes a secret-named number in JSON, like a PIN', () => {
    expect(redactSecrets('{"password": 12345, "port": 8080}').text).toBe(
      `{"password": "${R}", "port": 8080}`
    )
  })

  it('removes secret-named values in JSON, but not look-alike names', () => {
    const json = '{"apiKey": "abc123", "password": "hunter2", "author": "Paul", "oauthUrl": "x"}'
    expect(redactSecrets(json).text).toBe(
      `{"apiKey": "${R}", "password": "${R}", "author": "Paul", "oauthUrl": "x"}`
    )
  })

  it('removes values in .env files, YAML and command lines', () => {
    const env = 'API_KEY=abc123\nDB_PASSWORD="hunter2 with spaces"\nDEBUG=true'
    expect(redactSecrets(env).text).toBe(`API_KEY=${R}\nDB_PASSWORD=${R}\nDEBUG=true`)
    expect(redactSecrets('password: hunter2').text).toBe(`password: ${R}`)
    expect(redactSecrets('mysql --password=hunter2 -u root').text).toBe(
      `mysql --password=${R} -u root`
    )
    expect(redactSecrets('gh auth --token=abc123').text).toBe(`gh auth --token=${R}`)
  })

  it('returns text without secrets untouched', () => {
    const text = 'npm test\n✓ 209 passed in 2.1s\nsrc/main/index.ts:42'
    expect(redactSecrets(text)).toEqual({ text, count: 0 })
  })

  it('finds nothing new on a second pass', () => {
    const text = [
      'API_KEY=abc123',
      'postgres://admin:s3cret@db/app',
      'Authorization: Bearer abc123def456ghi789',
      '{"token": "xyz"}',
      `sk-ant-api03-${'a'.repeat(40)}`
    ].join('\n')
    const first = redactSecrets(text)
    expect(first.count).toBe(5)
    expect(redactSecrets(first.text)).toEqual({ text: first.text, count: 0 })
  })
})
