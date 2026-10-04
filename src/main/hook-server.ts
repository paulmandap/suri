import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseHookEvent, type HookEvent } from '@shared/hook-events'
import type { HookServerStatus } from '@shared/types'

export const MAX_BODY_BYTES = 1024 * 1024

/** A JSON answer for Claude Code, or null for an empty 200 (no decision). */
export type HookAnswer = Record<string, unknown> | null

export interface HookRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
  /** Aborted when Claude Code closes the request before Suri answers. */
  signal?: AbortSignal
}

export interface HookReply {
  status: number
  body: string
  contentType?: string
}

export interface HookHandlerOptions {
  port: number
  token: string
  isPaused: () => boolean
  /** Called for every valid, subscribed event. May return an answer (Phase 2 approvals). */
  onEvent: (
    event: HookEvent,
    context: { signal: AbortSignal }
  ) => HookAnswer | void | Promise<HookAnswer | void>
  log?: (line: string) => void
}

const EMPTY: HookReply = { status: 200, body: '' }

/**
 * Decides the reply to one hook request. Socket-free, so every check is unit
 * tested. Claude Code treats any non-2xx as a non-blocking error, so a
 * rejection never stalls a session; it only keeps strangers out.
 */
export async function handleHookRequest(
  req: HookRequest,
  opts: HookHandlerOptions
): Promise<HookReply> {
  if (req.method !== 'POST') return text(405, 'method not allowed')
  if (req.url.split('?')[0] !== '/hooks') return text(404, 'not found')

  // An exact Host stops DNS-rebinding pages; any Origin means a browser sent it.
  const host = header(req.headers, 'host')?.toLowerCase()
  if (host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) {
    return text(403, 'bad host')
  }
  if (header(req.headers, 'origin') !== undefined) return text(403, 'origin not allowed')
  if (!tokenMatches(header(req.headers, 'authorization'), opts.token)) {
    return text(401, 'unauthorized')
  }
  const type = header(req.headers, 'content-type')
  if (type !== undefined && !type.toLowerCase().startsWith('application/json')) {
    return text(415, 'json only')
  }
  if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) return text(413, 'too large')

  let json: unknown
  try {
    json = JSON.parse(req.body)
  } catch {
    return text(400, 'invalid json')
  }

  // Paused: answer at once and let Claude Code carry on as if Suri weren't here.
  if (opts.isPaused()) return EMPTY

  const parsed = parseHookEvent(json)
  if (!parsed.ok) {
    if (parsed.reason === 'unknown-event') return EMPTY
    opts.log?.(`invalid hook payload: ${parsed.issues}`)
    return text(400, 'invalid payload')
  }

  try {
    const signal = req.signal ?? new AbortController().signal
    const answer = await opts.onEvent(parsed.event, { signal })
    return answer
      ? { status: 200, body: JSON.stringify(answer), contentType: 'application/json' }
      : EMPTY
  } catch (err) {
    // A bug in Suri must never fail Claude Code.
    opts.log?.(`hook handler failed: ${String(err)}`)
    return EMPTY
  }
}

export interface HookServer {
  start(): Promise<HookServerStatus>
  stop(): Promise<void>
  status(): HookServerStatus
  onStatus(listener: (status: HookServerStatus) => void): () => void
}

/** The HTTP adapter around handleHookRequest. Listens on 127.0.0.1 only. */
export function createHookServer(opts: HookHandlerOptions): HookServer {
  let current: HookServerStatus = { state: 'starting', port: opts.port }
  let boundPort = opts.port
  const listeners = new Set<(status: HookServerStatus) => void>()
  const setStatus = (next: HookServerStatus): void => {
    current = next
    for (const listener of listeners) listener(next)
  }

  const server = createServer((req, res) => {
    void serve(req, res)
  })
  // A PermissionRequest may be held for ~110 s once approvals arrive (Phase 2).
  server.requestTimeout = 130_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A held PermissionRequest must notice when Claude Code stops waiting for it.
    const gone = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) gone.abort()
    })
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        const buffer = chunk as Buffer
        size += buffer.length
        if (size > MAX_BODY_BYTES) {
          send(res, text(413, 'too large'))
          req.destroy()
          return
        }
        chunks.push(buffer)
      }
      const reply = await handleHookRequest(
        {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          signal: gone.signal
        },
        { ...opts, port: boundPort }
      )
      send(res, reply)
    } catch (err) {
      opts.log?.(`request failed: ${String(err)}`)
      if (!res.headersSent) send(res, EMPTY)
    }
  }

  return {
    start: () =>
      new Promise((resolve) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          setStatus({
            state: 'error',
            port: opts.port,
            message: describeListenError(err, opts.port)
          })
          resolve(current)
        }
        server.once('error', onError)
        server.listen(opts.port, '127.0.0.1', () => {
          server.off('error', onError)
          boundPort = (server.address() as AddressInfo).port
          setStatus({ state: 'listening', port: boundPort })
          resolve(current)
        })
      }),
    stop: () =>
      new Promise((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
    status: () => current,
    onStatus(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

function send(res: ServerResponse, reply: HookReply): void {
  if (res.writableEnded) return
  res.writeHead(reply.status, {
    'Content-Type': reply.contentType ?? 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(reply.body, 'utf8')
  })
  res.end(reply.body)
}

function text(status: number, body: string): HookReply {
  return { status, body }
}

function header(headers: HookRequest['headers'], name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Constant-time compare, so the token can't be guessed byte by byte. */
function tokenMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization || !token) return false
  const expected = Buffer.from(`Bearer ${token}`, 'utf8')
  const actual = Buffer.from(authorization, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function describeListenError(err: NodeJS.ErrnoException, port: number): string {
  if (err.code === 'EADDRINUSE') return `Port ${port} is already in use.`
  if (err.code === 'EACCES') return `Port ${port} isn't allowed.`
  return err.message
}
