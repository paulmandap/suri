import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_BODY_BYTES,
  createHookServer,
  handleHookRequest,
  type HookHandlerOptions,
  type HookRequest,
  type HookServer
} from '../src/main/hook-server'
import { fixture } from './helpers'

const TOKEN = 'a'.repeat(64)
const BODY = JSON.stringify(fixture('UserPromptSubmit'))
const HEADERS = {
  host: '127.0.0.1:47821',
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json'
}

function options(over: Partial<HookHandlerOptions> = {}): HookHandlerOptions {
  return { port: 47821, token: TOKEN, isPaused: () => false, onEvent: vi.fn(() => null), ...over }
}

function request(over: Partial<HookRequest> = {}): HookRequest {
  return { method: 'POST', url: '/hooks', headers: HEADERS, body: BODY, ...over }
}

describe('handleHookRequest', () => {
  it('passes a valid event on and answers an empty 200', async () => {
    const opts = options()
    expect(await handleHookRequest(request(), opts)).toEqual({ status: 200, body: '' })
    expect(opts.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        hook_event_name: 'UserPromptSubmit',
        session_id: expect.any(String)
      })
    )
  })

  it('sends an answer back as JSON (Phase 2 approvals)', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PermissionRequest' } }
    const reply = await handleHookRequest(request(), options({ onEvent: () => answer }))
    expect(reply).toEqual({
      status: 200,
      body: JSON.stringify(answer),
      contentType: 'application/json'
    })
  })

  it.each([
    ['a GET', request({ method: 'GET' }), 405],
    ['another path', request({ url: '/admin' }), 404],
    [
      'a foreign Host (DNS rebinding)',
      request({ headers: { ...HEADERS, host: 'evil.example:47821' } }),
      403
    ],
    [
      'a Host with the wrong port',
      request({ headers: { ...HEADERS, host: '127.0.0.1:9999' } }),
      403
    ],
    [
      'any Origin (a browser)',
      request({ headers: { ...HEADERS, origin: 'https://evil.example' } }),
      403
    ],
    ['no token', request({ headers: { ...HEADERS, authorization: undefined } }), 401],
    [
      'a wrong token',
      request({ headers: { ...HEADERS, authorization: `Bearer ${'b'.repeat(64)}` } }),
      401
    ],
    [
      'a non-JSON body type',
      request({ headers: { ...HEADERS, 'content-type': 'text/plain' } }),
      415
    ],
    ['an oversized body', request({ body: 'x'.repeat(MAX_BODY_BYTES + 1) }), 413],
    ['broken JSON', request({ body: '{ nope' }), 400]
  ])('rejects %s', async (_label, req, status) => {
    const opts = options()
    expect((await handleHookRequest(req, opts)).status).toBe(status)
    expect(opts.onEvent).not.toHaveBeenCalled()
  })

  it('accepts localhost as the Host too', async () => {
    const reply = await handleHookRequest(
      request({ headers: { ...HEADERS, host: 'localhost:47821' } }),
      options()
    )
    expect(reply.status).toBe(200)
  })

  it('answers at once and ignores the event while paused', async () => {
    const opts = options({ isPaused: () => true })
    expect(await handleHookRequest(request(), opts)).toEqual({ status: 200, body: '' })
    expect(opts.onEvent).not.toHaveBeenCalled()
  })

  it('ignores events it does not subscribe to', async () => {
    const opts = options()
    const body = JSON.stringify({ ...fixture('Stop'), hook_event_name: 'PostToolBatch' })
    expect(await handleHookRequest(request({ body }), opts)).toEqual({ status: 200, body: '' })
    expect(opts.onEvent).not.toHaveBeenCalled()
  })

  it('rejects a subscribed event with a broken shape, and says why in the log', async () => {
    const log = vi.fn()
    const body = JSON.stringify({ hook_event_name: 'Stop', cwd: 'C:\\x' })
    const reply = await handleHookRequest(request({ body }), options({ log }))
    expect(reply.status).toBe(400)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('session_id'))
  })

  it('never fails Claude Code when Suri itself throws', async () => {
    const log = vi.fn()
    const onEvent = (): never => {
      throw new Error('bug in Suri')
    }
    expect(await handleHookRequest(request(), options({ onEvent, log }))).toEqual({
      status: 200,
      body: ''
    })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bug in Suri'))
  })
})

// A real round trip on 127.0.0.1 (loopback only, no internet).
describe('createHookServer', () => {
  const servers: HookServer[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()))
  })

  async function listening(over: Partial<HookHandlerOptions> = {}): Promise<{
    server: HookServer
    port: number
    opts: HookHandlerOptions
  }> {
    const opts = options({ port: 0, ...over })
    const server = createHookServer(opts)
    servers.push(server)
    const status = await server.start()
    if (status.state !== 'listening') throw new Error(`not listening: ${JSON.stringify(status)}`)
    return { server, port: status.port, opts }
  }

  const post = (port: number, body: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body
    })

  it('serves a hook end to end', async () => {
    const { port, opts } = await listening()
    const res = await post(port, BODY)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(opts.onEvent).toHaveBeenCalledTimes(1)
  })

  it('refuses a body that grows past the limit', async () => {
    const { port, opts } = await listening()
    const res = await post(port, 'x'.repeat(MAX_BODY_BYTES + 10)).catch(() => null)
    // Either a 413, or the connection is cut mid-upload. Never a 200.
    if (res) expect(res.status).toBe(413)
    expect(opts.onEvent).not.toHaveBeenCalled()
  })

  it('reports a port that is already taken', async () => {
    const { port } = await listening()
    const second = createHookServer(options({ port }))
    servers.push(second)
    const status = await second.start()
    expect(status).toEqual({
      state: 'error',
      port,
      message: `Port ${port} is already in use.`
    })
  })
})
