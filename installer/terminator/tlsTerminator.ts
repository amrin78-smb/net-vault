//
// installer/terminator/tlsTerminator.ts — the NocVault suite's SHARED TLS
// terminator. One process, four public ports, four loopback upstreams.
//
// ⛔ WHY ONE TERMINATOR AND NOT FOUR CUSTOM SERVERS. SecVault wraps Next's
// request handler in `https.createServer` from its own `server.js`, and that
// shape does not port here for two independent reasons:
//
//   1. NetVault is built with `output: 'standalone'` and NSSM runs Next's OWN
//      GENERATED `.next/standalone/server.js` (see
//      Install-NocVault-Suite.ps1's `nssm install NetVault ... $NVStandalone\server.js`).
//      You cannot drop a hand-written server beside a generated one — the next
//      build overwrites the directory it lives in.
//   2. Four apps would mean four certificate installs and four renewals of the
//      same customer-supplied certificate, on a box whose operator already has
//      to be talked through one.
//
// So TLS is terminated ONCE, in front of everything, and each console keeps
// serving plain HTTP on a loopback port it no longer publishes.
//
// ⛔ THE SAME-PORT PLAINTEXT DEMUX IS THE BEST IDEA IN SECVAULT'S DESIGN AND IS
// NOT A NICETY. A plaintext request arriving at a TLS listener is not a
// redirect, it is a PROTOCOL FAILURE: an old `http://host:3000` bookmark gets an
// unexplained connection error with nothing in any log to explain it. A TLS
// handshake begins with byte 0x16, so the front door peeks the first byte and
// hands the connection to either the TLS server or a plain HTTP server that
// answers 301. See `demux()`.
//
// ⛔ A BROKEN CERTIFICATE DEGRADES TO PLAIN HTTP, LOUDLY, RATHER THAN REFUSING
// TO START. On a monitoring suite an outage means nobody can see the network,
// which has its own cost. That is only safe BECAUSE `failed` is never silent —
// `logTransportBanner` writes an error-level banner on EVERY start. Do not make
// it quiet. (The reasoning in full is at the top of lib/tlsConfig.ts.)
//
// ⛔ NOTHING IS NAILED TO ONE APP. Every listener is a pair
// (public port -> loopback port), resolved per app from the environment by
// `lib/tlsConfig.ts`'s own port resolver with per-app fallbacks. There is no
// `3000` anywhere below except in SUITE_UPSTREAMS' default table.
//
// ⛔ THE DECISION LAYER IS NOT RE-IMPLEMENTED HERE. The three transport states,
// the port rules and the proof that the certificate material actually loads all
// come from `resolveTlsConfig`. This file binds sockets and moves bytes; it
// makes no judgement about the certificate. A second copy of that judgement is
// exactly how `scripts/test-mfa.cjs` ended up carrying a mirror of lib/mfa.ts
// that has to be hand-maintained — see its own header.
//
// ⛔ WHY TYPESCRIPT. The decision layer is a `.ts` file and must be LOADED by
// this process either way, so writing the terminator in JavaScript would not
// avoid needing a Node that can load `lib/tlsConfig.ts` — it would only give up
// the compile-time contract with it. `npx tsc --noEmit` / `next build` already
// type-check `**/*.ts`, so a signature change in `resolveTlsConfig` breaks the
// build instead of breaking at 3am on a customer's console. The runtime
// requirement this creates is REPORTED, not worked around: see the header of
// nocvault-tls-terminator.ts.

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import {
  describeTlsStatus,
  portFrom,
  resolveTlsConfig,
  type TlsConfig,
  type TlsEnv,
  type TlsFsImpl,
} from '../../lib/tlsConfig.ts'

// ⛔ `127.0.0.1`, NEVER `localhost`. CLAUDE.md records this as a real incident
// (fixed in netvault 1.23.6): on Windows `localhost` resolves to `::1` first,
// the suite apps listen on IPv4 only, and every connect stalls ~1s on the dead
// `::1` attempt before falling back. On a terminator that is a per-request cost
// on every page load of every console.
export const UPSTREAM_HOST = '127.0.0.1'

/** The first byte of a TLS ClientHello. Anything else is plaintext. */
export const TLS_HANDSHAKE_FIRST_BYTE = 0x16

// ⛔ A FIRST-BYTE TIMEOUT IS REQUIRED, NOT DEFENSIVE. A client that connects and
// then says nothing holds a socket open forever while we wait to decide which
// server it belongs to — and firewalls, load-balancer health probes and port
// scanners ALL do exactly this. Without it the terminator leaks a file
// descriptor per probe until it cannot accept a real connection.
export const FIRST_BYTE_TIMEOUT_MS = 15000

/**
 * Headers a CLIENT may not speak.
 *
 * ⛔ EVERY ONE OF THESE IS DELETED AND THEN SET BY US — OVERWRITTEN, NEVER
 * APPENDED TO. CLAUDE.md's "Cross-app URL resolution" section records a known
 * hardening gap: `lib/publicUrl.ts`'s `resolveOrigin` trusts `x-forwarded-host`
 * after only a HOSTNAME-SHAPE check, not an allowlist, and the SSO handoff
 * routes put a short-lived signed token in a redirect URL built from it.
 * Putting a proxy in front makes that gap live, so this is the one place the
 * terminator must not be careless:
 *
 *   - leaving a client value in place would let anyone reaching the terminator
 *     steer an SSO redirect (and the token in it) at a host they control;
 *   - APPENDING ours after theirs is worse than it looks, and both halves were
 *     read off `resolveOrigin` rather than assumed. For the host it reads the
 *     WHOLE value and only strips a `:port`, so `evil.test, real.test` fails
 *     HOSTNAME_RE and silently falls back to the install-time NEXTAUTH_URL —
 *     the exact bug `resolveOrigin` was written to fix. For the proto it takes
 *     `.split(',')[0]`, i.e. the CLIENT'S value, so a client sending
 *     `x-forwarded-proto: http` would downgrade every URL the app builds while
 *     the connection is genuinely TLS.
 *
 * `forwarded` (RFC 7239) is in the list because it carries the same facts in a
 * different grammar, and an app that ever starts reading it must not find a
 * client's copy.
 */
const CLIENT_FORWARDED_HEADERS = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-forwarded-scheme',
  'x-forwarded-server',
  'x-forwarded-ssl',
  'x-real-ip',
])

/** Hop-by-hop headers: meaningful between two endpoints, never relayed. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface TerminatorLog {
  info(message: string): void
  error(message: string): void
}

export const consoleLog: TerminatorLog = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
}

/** One console behind the terminator. */
export interface UpstreamSpec {
  /** Lower-case app slug; also the prefix of its environment keys. */
  app: string
  /** The port the world connects to. */
  publicPortDefault: number
  /** The loopback port that app's own server listens on. */
  upstreamPortDefault: number
}

// ⛔ The PUBLIC ports are today's ports, deliberately unchanged, so every
// bookmark, ticket link, firewall rule and sibling-app health probe still points
// at the right place. The LOOPBACK ports are the public port + 10000 — the apps
// move, the addresses people typed do not.
export const SUITE_UPSTREAMS: readonly UpstreamSpec[] = [
  { app: 'netvault', publicPortDefault: 3000, upstreamPortDefault: 13000 },
  { app: 'logvault', publicPortDefault: 3004, upstreamPortDefault: 13004 },
  { app: 'ddivault', publicPortDefault: 3006, upstreamPortDefault: 13006 },
  { app: 'spanvault', publicPortDefault: 3008, upstreamPortDefault: 13008 },
]

/**
 * The per-app view of the environment handed to `resolveTlsConfig`.
 *
 * ⛔ THE CERTIFICATE IS SHARED AND THE PORTS ARE NOT. One certificate install is
 * the whole reason this process exists, so TLS_CERT_PATH/TLS_KEY_PATH are read
 * straight from the real environment; the ports are read from `<APP>_`-prefixed
 * keys so four listeners can live in one process.
 *
 * ⛔ `PORT` IS DELIBERATELY NOT FORWARDED, and leaving it in would be a real
 * bug: `resolveTlsConfig` falls back `HTTPS_PORT || PORT`, and a terminator
 * service that inherited `PORT=3000` from anywhere would resolve ALL FOUR
 * consoles onto port 3000 — three of which would fail to bind, with a message
 * about an address in use rather than about the misconfiguration.
 */
export function upstreamEnv(app: string, env: TlsEnv): TlsEnv {
  const prefix = app.toUpperCase()
  return {
    HTTPS_PORT: env[`${prefix}_HTTPS_PORT`],
    HTTP_REDIRECT_PORT: env[`${prefix}_HTTP_REDIRECT_PORT`],
    TLS_CERT_PATH: env.TLS_CERT_PATH,
    TLS_KEY_PATH: env.TLS_KEY_PATH,
  }
}

/** One resolved listener, before anything binds. */
export interface UpstreamPlan {
  app: string
  publicPort: number
  upstreamPort: number
  /** The dedicated plain-HTTP redirect port; bound only when TLS is active. */
  httpRedirectPort: number
  tls: TlsConfig
}

/**
 * Resolve every upstream from the environment. Pure apart from the certificate
 * read `resolveTlsConfig` does, and binds nothing — so a test (or a dry-run
 * flag) can see the whole layout without taking a port.
 */
export function resolveUpstreamPlan(
  env: TlsEnv,
  fsImpl?: TlsFsImpl,
  upstreams: readonly UpstreamSpec[] = SUITE_UPSTREAMS,
): UpstreamPlan[] {
  return upstreams.map((spec) => {
    const tls = resolveTlsConfig(upstreamEnv(spec.app, env), fsImpl, {
      httpsPort: spec.publicPortDefault,
      // +80 keeps the convention SecVault set (3010 -> 3080) while staying
      // derivable per app: 3000/3004/3006/3008 -> 3080/3084/3086/3088.
      httpPort: spec.publicPortDefault + 80,
    })
    return {
      app: spec.app,
      publicPort: tls.httpsPort,
      upstreamPort: portFrom(
        env[`${spec.app.toUpperCase()}_UPSTREAM_PORT`],
        spec.upstreamPortDefault,
      ),
      httpRedirectPort: tls.httpPort,
      tls,
    }
  })
}

/**
 * The start-up transport banner.
 *
 * ⛔ `failed` IS LOGGED AT ERROR LEVEL ON EVERY START AND THAT IS WHAT MAKES THE
 * DEGRADE-TO-HTTP CHOICE SAFE. The operator asked for TLS and is not getting
 * it; a reader who skims this log and concludes "we're encrypted" has reached
 * the exact opposite of the truth. `disabled` is NOT an error — it is how the
 * whole suite has shipped for its entire life — so it goes to info.
 */
export function logTransportBanner(tls: TlsConfig, log: TerminatorLog = consoleLog): void {
  const line = describeTlsStatus(tls)
  if (tls.status === 'failed') {
    const rule = '='.repeat(72)
    log.error('')
    log.error(`  ${rule}`)
    log.error(`  ${line}`)
    log.error('  The NocVault consoles ARE reachable, but traffic is NOT encrypted.')
    log.error('  Every session, including the hub login, crosses the network in the clear.')
    log.error('  Fix TLS_CERT_PATH / TLS_KEY_PATH and restart the terminator.')
    log.error(`  ${rule}`)
    log.error('')
    return
  }
  log.info(`[nocvault-tls] ${line}`)
}
// ⛔ THE BANNER DOES NOT LIST THE LISTENERS, deliberately. It runs BEFORE
// anything binds, so a list printed here would name a console that then failed
// to take its port — a planned layout read as a fact. Each listener announces
// ITSELF from startUpstream once it is actually serving, and a console missing
// from that run of lines is the signal.

/** What the proxy needs to know, resolved once per upstream. */
interface ProxyContext {
  app: string
  upstreamPort: number
  proto: 'http' | 'https'
  /** A getter, because an ephemeral public port is only known after bind. */
  publicPort: () => number
  /** When set, pins X-Forwarded-Host instead of echoing the client's Host. */
  publicHost: string | null
  log: TerminatorLog
}

/**
 * Build the header set sent upstream.
 *
 * ⛔ STRIP THEN SET. See CLIENT_FORWARDED_HEADERS above for why a client's
 * `X-Forwarded-*` is DELETED rather than appended to — this function is the
 * whole of the terminator's answer to that question.
 */
export function forwardedHeaders(
  req: http.IncomingMessage,
  ctx: Pick<ProxyContext, 'proto' | 'publicHost' | 'publicPort'>,
  keepHopByHop = false,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const name of Object.keys(req.headers)) {
    const key = name.toLowerCase()
    if (CLIENT_FORWARDED_HEADERS.has(key)) continue
    if (!keepHopByHop && HOP_BY_HOP.has(key)) continue
    const value = req.headers[name]
    if (value !== undefined) out[name] = value
  }

  out['x-forwarded-proto'] = ctx.proto
  // ⛔ The Host header is itself client-supplied, so pinning it is the only way
  // to make X-Forwarded-Host trustworthy rather than merely un-injectable. When
  // TLS_PUBLIC_HOST is unset we echo Host, which is exactly the status quo
  // `resolveOrigin` already has — never worse, and the residual is reported
  // rather than hidden.
  const host = (ctx.publicHost || req.headers.host || '').trim()
  if (host) out['x-forwarded-host'] = host
  out['x-forwarded-port'] = String(ctx.publicPort())
  const remote = req.socket.remoteAddress
  if (remote) out['x-forwarded-for'] = remote
  return out
}

/** Response headers, minus the ones that describe THIS connection. */
function responseHeaders(upstream: http.IncomingMessage): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const name of Object.keys(upstream.headers)) {
    const key = name.toLowerCase()
    if (key === 'connection' || key === 'transfer-encoding' || key === 'keep-alive') continue
    const value = upstream.headers[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/**
 * Proxy one request to the loopback console.
 *
 * ⛔ STREAMED, NEVER BUFFERED. `req.pipe()` / `res` piping means a 400 MB
 * LogVault export or a long-poll never sits in this process's heap. Buffering
 * would turn one CSV download into an OOM on a box that is also running four
 * Next apps, PostgreSQL and three collectors.
 */
function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: ProxyContext): void {
  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: ctx.upstreamPort,
    method: req.method,
    path: req.url,
    headers: forwardedHeaders(req, ctx),
  })

  upstream.on('response', (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders(upstreamRes))
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err) => {
    ctx.log.error(
      `[nocvault-tls] ${ctx.app}: ${UPSTREAM_HOST}:${ctx.upstreamPort} did not answer: ${err.message}`,
    )
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    res.end(`The ${ctx.app} console behind this port is not responding.\n`)
  })

  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
}

/**
 * Proxy a protocol upgrade (SpanVault's agent ingest and DDIVault's listener
 * are both WebSocket). Hop-by-hop headers are KEPT here — `Connection:
 * Upgrade` and `Upgrade: websocket` are the request.
 */
function proxyUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  ctx: ProxyContext,
): void {
  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: ctx.upstreamPort,
    method: req.method || 'GET',
    path: req.url,
    headers: forwardedHeaders(req, ctx, true),
  })

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    clientSocket.write(statusLines(upstreamRes))
    if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead)
    // Bytes the client had already sent after its handshake belong upstream.
    if (head && head.length) upstreamSocket.write(head)
    // ⛔ `pipe()` does not propagate a destroy, so each side is torn down
    // explicitly. One half of a tunnel outliving the other is a socket (and a
    // WinRM/agent session) leaked per reconnect.
    upstreamSocket.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.on('close', () => clientSocket.destroy())
    clientSocket.on('close', () => upstreamSocket.destroy())
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
  })

  // The console refused the upgrade (401, 404, 426...). Relay its answer
  // verbatim rather than dropping the connection — a client that is told "401"
  // can be fixed; one that is hung up on cannot.
  upstream.on('response', (upstreamRes) => {
    clientSocket.write(statusLines(upstreamRes))
    upstreamRes.pipe(clientSocket)
  })

  upstream.on('error', (err) => {
    ctx.log.error(
      `[nocvault-tls] ${ctx.app}: upgrade to ${UPSTREAM_HOST}:${ctx.upstreamPort} failed: ${err.message}`,
    )
    clientSocket.destroy()
  })
  clientSocket.on('error', () => upstream.destroy())
  upstream.end()
}

/** Serialise a status line + headers back onto a raw socket. */
function statusLines(res: http.IncomingMessage): string {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage || ''}`.trimEnd()]
  for (const name of Object.keys(res.headers)) {
    const value = res.headers[name]
    if (Array.isArray(value)) {
      for (const one of value) lines.push(`${name}: ${one}`)
    } else if (value !== undefined) {
      lines.push(`${name}: ${value}`)
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/** 301 everything at the https origin on the same host. */
function redirectHandler(httpsPort: () => number) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const host = (req.headers.host || '').split(':')[0] || 'localhost'
    const port = httpsPort()
    const suffix = port === 443 ? '' : `:${port}`
    res.writeHead(301, {
      Location: `https://${host}${suffix}${req.url || '/'}`,
      'Content-Length': '0',
    })
    res.end()
  }
}

/**
 * Route one connection on the TLS port to either the TLS server or the
 * plaintext redirect server, by peeking at its first byte.
 *
 * ⛔ `socket.unshift` IS LOAD-BEARING. The byte has ALREADY BEEN CONSUMED by the
 * time we can look at it, so it must be pushed back before the chosen server
 * reads the stream — otherwise every request loses its first character: a TLS
 * ClientHello stops being a ClientHello and `GET /x` arrives as `ET /x`, which
 * the HTTP parser rejects without an answer. Pause first, unshift, hand over,
 * then resume on the NEXT TICK so the receiving server has attached its own
 * listeners before data flows.
 */
export function demux(
  socket: Socket,
  tlsServer: https.Server,
  plainServer: http.Server,
  firstByteTimeoutMs: number,
): void {
  socket.setTimeout(firstByteTimeoutMs, () => socket.destroy())

  socket.once('data', (buf: Buffer) => {
    socket.setTimeout(0)
    socket.pause()
    socket.unshift(buf)
    const target = buf[0] === TLS_HANDSHAKE_FIRST_BYTE ? tlsServer : plainServer
    target.emit('connection', socket)
    process.nextTick(() => socket.resume())
  })

  // A socket that errors before its first byte is ordinary noise on a
  // network-facing port: a scan, a probe, a dropped connection. It must never
  // reach the process-level handler and take the terminator down.
  socket.on('error', () => socket.destroy())
}

export interface UpstreamOptions {
  app: string
  /** 0 binds an ephemeral port; the handle reports what was actually bound. */
  publicPort: number
  upstreamPort: number
  httpRedirectPort?: number | null
  tls: TlsConfig
  log?: TerminatorLog
  firstByteTimeoutMs?: number
  /** Pins X-Forwarded-Host. Null echoes the client's Host header. */
  publicHost?: string | null
}

export interface UpstreamHandle {
  app: string
  status: TlsConfig['status']
  publicPort: number
  httpRedirectPort: number | null
  close(): Promise<void>
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function boundPort(server: net.Server): number {
  const address = server.address()
  return address && typeof address === 'object' ? address.port : 0
}

function shutdown(servers: Array<net.Server>): Promise<void> {
  return Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          // closeAllConnections first: an idle keep-alive socket otherwise keeps
          // close() pending until its timeout, and a service stop must not wait.
          // Guarded AND cast because the method is `http.Server`'s — a
          // `net.Server` (the demux front door) does not have it, which is
          // exactly why `live` above exists.
          ;(server as http.Server).closeAllConnections?.()
          if (!server.listening) return resolve()
          server.close(() => resolve())
        }),
    ),
  ).then(() => undefined)
}

/**
 * Bring up ONE console's listeners.
 *
 * `active`              -> front door on the public port (demux: TLS or 301),
 *                          plus the dedicated plain-HTTP redirect port.
 * `disabled` / `failed` -> plain HTTP on the public port, proxied. Exactly what
 *                          the suite has always served, with the SAME ports.
 */
export async function startUpstream(opts: UpstreamOptions): Promise<UpstreamHandle> {
  const log = opts.log ?? consoleLog
  const firstByteTimeoutMs = opts.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS
  const publicHost = opts.publicHost ?? null

  let publicPort = opts.publicPort
  // ⛔ EVERY SOCKET THIS LISTENER OWNS IS TRACKED, because neither of the two
  // servers that end up handling one can be asked to close it:
  //   - `net.Server` (the demux front door) has no `closeAllConnections` —
  //     that is `http.Server`'s — and the socket it accepted was handed to a
  //     server that never bound a port, so nothing else knows it exists;
  //   - an UPGRADED socket is hijacked out of `http.Server`'s own bookkeeping,
  //     so `closeAllConnections()` does not reach it either. Measured: a stop
  //     with one open WebSocket left `close()` pending indefinitely.
  // Without this set a service stop waits on every open console tab and every
  // connected agent, and NSSM eventually KILLS the process instead of stopping
  // it — which is the one way to lose a clean shutdown on a restart loop.
  const live = new Set<Duplex>()
  const hold = (socket: Duplex): void => {
    live.add(socket)
    socket.on('close', () => live.delete(socket))
  }
  const dropAll = (): void => {
    for (const socket of live) socket.destroy()
    live.clear()
  }

  const ctx: ProxyContext = {
    app: opts.app,
    upstreamPort: opts.upstreamPort,
    proto: opts.tls.status === 'active' ? 'https' : 'http',
    publicPort: () => publicPort,
    publicHost,
    log,
  }

  // ── no usable TLS: plain HTTP, same port, same behaviour as before ────────
  if (opts.tls.status !== 'active') {
    const plain = http.createServer((req, res) => proxyRequest(req, res, ctx))
    plain.on('upgrade', (req, socket, head) => {
      hold(socket)
      proxyUpgrade(req, socket, head, ctx)
    })
    await listen(plain, opts.publicPort)
    publicPort = boundPort(plain)
    log.info(
      `[nocvault-tls] ${opts.app}: listening on http://0.0.0.0:${publicPort}` +
        ` -> ${UPSTREAM_HOST}:${opts.upstreamPort}`,
    )
    return {
      app: opts.app,
      status: opts.tls.status,
      publicPort,
      httpRedirectPort: null,
      close: async () => {
        dropAll()
        await shutdown([plain])
      },
    }
  }

  // ── TLS ───────────────────────────────────────────────────────────────────
  const tlsServer = https.createServer(
    {
      cert: opts.tls.cert as Buffer,
      key: opts.tls.key as Buffer,
      // ⛔ TLS 1.2 FLOOR. 1.0/1.1 are deprecated and are a finding in any scan
      // of an infrastructure console; nothing older has any business carrying a
      // suite administrator's session in 2026.
      minVersion: 'TLSv1.2',
    },
    (req, res) => proxyRequest(req, res, ctx),
  )
  tlsServer.on('upgrade', (req, socket, head) => {
    hold(socket)
    proxyUpgrade(req, socket, head, ctx)
  })
  // Scans and probes produce these constantly on a network-facing port and none
  // of them is actionable.
  tlsServer.on('tlsClientError', () => {})

  const plainOnTlsPort = http.createServer(redirectHandler(() => publicPort))

  // Neither server above binds anything itself — the front door does, and hands
  // each connection to whichever one its first byte says it belongs to.
  const front = net.createServer((socket) => {
    hold(socket)
    demux(socket, tlsServer, plainOnTlsPort, firstByteTimeoutMs)
  })
  await listen(front, opts.publicPort)
  publicPort = boundPort(front)
  log.info(
    `[nocvault-tls] ${opts.app}: listening on https://0.0.0.0:${publicPort}` +
      ` -> ${UPSTREAM_HOST}:${opts.upstreamPort} (plaintext on this port is redirected)`,
  )

  const servers: net.Server[] = [front]
  let httpRedirectPort: number | null = null

  const wanted = opts.httpRedirectPort ?? null
  if (wanted !== null && wanted > 0 && wanted !== publicPort) {
    const redirector = http.createServer(redirectHandler(() => publicPort))
    // ⛔ NEVER FATAL. The dedicated redirect port is a convenience — the
    // same-port demux already answers every old http:// bookmark — so failing
    // to bind it must not take down a console that is already serving.
    try {
      await listen(redirector, wanted)
      httpRedirectPort = boundPort(redirector)
      servers.push(redirector)
      log.info(
        `[nocvault-tls] ${opts.app}: redirecting http://0.0.0.0:${httpRedirectPort}` +
          ` -> https://…:${publicPort}`,
      )
    } catch (err) {
      log.error(
        `[nocvault-tls] ${opts.app}: HTTP redirect port ${wanted} unavailable: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    app: opts.app,
    status: opts.tls.status,
    publicPort,
    httpRedirectPort,
    close: async () => {
      dropAll()
      tlsServer.closeAllConnections?.()
      plainOnTlsPort.closeAllConnections?.()
      await shutdown(servers)
    },
  }
}

export interface TerminatorOptions {
  log?: TerminatorLog
  fsImpl?: TlsFsImpl
  firstByteTimeoutMs?: number
  upstreams?: readonly UpstreamSpec[]
}

/**
 * Bring up the whole suite's front door.
 *
 * ⛔ ONE FAILED UPSTREAM MUST NOT TAKE THE OTHERS DOWN. A console whose public
 * port is already held by something else is a configuration problem on that one
 * app; letting it abort startup would make the whole suite unreachable because
 * one port was busy.
 */
export async function startTerminator(
  env: TlsEnv = process.env as TlsEnv,
  opts: TerminatorOptions = {},
): Promise<UpstreamHandle[]> {
  const log = opts.log ?? consoleLog
  const plan = resolveUpstreamPlan(env, opts.fsImpl, opts.upstreams)

  // The certificate is shared, so the transport state is one fact about the
  // whole suite. The hub's config carries it (and is always present).
  logTransportBanner(plan[0].tls, log)

  const publicHost = (env.TLS_PUBLIC_HOST || '').trim() || null
  const handles: UpstreamHandle[] = []
  for (const entry of plan) {
    try {
      handles.push(
        await startUpstream({
          app: entry.app,
          publicPort: entry.publicPort,
          upstreamPort: entry.upstreamPort,
          httpRedirectPort: entry.httpRedirectPort,
          tls: entry.tls,
          log,
          firstByteTimeoutMs: opts.firstByteTimeoutMs,
          publicHost,
        }),
      )
    } catch (err) {
      log.error(
        `[nocvault-tls] ${entry.app}: could not listen on ${entry.publicPort}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return handles
}
