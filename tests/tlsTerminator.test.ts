import { after, before, test } from 'node:test'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import type { Duplex } from 'node:stream'

import { resolveTlsConfig, type TlsConfig, type TlsEnv } from '../lib/tlsConfig.ts'
import {
  isTypeScriptUnsupported,
  unsupportedRuntimeMessage,
} from '../installer/terminator/start.mjs'
import {
  FIRST_BYTE_TIMEOUT_MS,
  TLS_HANDSHAKE_FIRST_BYTE,
  UPSTREAM_HOST,
  resolveUpstreamPlan,
  startTerminator,
  startUpstream,
  upstreamEnv,
  type TerminatorLog,
  type UpstreamHandle,
} from '../installer/terminator/tlsTerminator.ts'

// ─────────────────────────────────────────────────────────────────────────────
// This is a NETWORK LISTENER, so it is driven over real sockets rather than
// asserted about from its source: an ephemeral public port, a trivial loopback
// upstream, and a real client on the other end. Nothing here reads the
// terminator's own text looking for the right words.
//
// ⛔ NO KEY OR CERTIFICATE IS COMMITTED. A 2048-bit RSA pair and a matching
// self-signed X.509 are minted ONCE at test time with `node:crypto` alone (no
// openssl in the path, so there is no skip branch and no "could not measure
// here"), into a temp directory, for the RFC 2606 reserved name
// `tls-test.invalid`, valid for two days.
// ─────────────────────────────────────────────────────────────────────────────

// ── minimal DER, enough for one self-signed certificate ─────────────────────

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content])
}

const derSeq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts))
const derSet = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts))
const derNull = (): Buffer => Buffer.from([0x05, 0x00])
const derUtf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
const derOctet = (content: Buffer): Buffer => tlv(0x04, content)
const derBitString = (content: Buffer): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.from([0]), content]))

function derOid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const body: number[] = [parts[0] * 40 + parts[1]]
  for (const part of parts.slice(2)) {
    const chunks: number[] = []
    let v = part
    do {
      chunks.unshift(v & 0x7f)
      v = v >>> 7
    } while (v > 0)
    for (let i = 0; i < chunks.length - 1; i += 1) chunks[i] |= 0x80
    body.push(...chunks)
  }
  return tlv(0x06, Buffer.from(body))
}

function derInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  if (bytes.length === 0) bytes.push(0)
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
  return tlv(0x02, Buffer.from(bytes))
}

function derUtcTime(when: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const text =
    pad(when.getUTCFullYear() % 100) +
    pad(when.getUTCMonth() + 1) +
    pad(when.getUTCDate()) +
    pad(when.getUTCHours()) +
    pad(when.getUTCMinutes()) +
    pad(when.getUTCSeconds()) +
    'Z'
  return tlv(0x17, Buffer.from(text, 'ascii'))
}

function pem(label: string, der: Buffer): string {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

/** An RSA key plus a self-signed certificate for it, both PEM. */
function selfSigned(commonName: string): { certPem: string; keyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })

  const sha256WithRsa = derSeq(derOid('1.2.840.113549.1.1.11'), derNull())
  const name = derSeq(derSet(derSeq(derOid('2.5.4.3'), derUtf8(commonName))))
  const now = Date.now()
  const validity = derSeq(
    derUtcTime(new Date(now - 60_000)),
    derUtcTime(new Date(now + 2 * 24 * 60 * 60 * 1000)),
  )
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  // SubjectAltName: SEQUENCE { [2] IA5String dNSName }. Browsers ignore the CN
  // entirely, so the realistic shape is the one worth exercising.
  const san = derSeq(tlv(0x82, Buffer.from(commonName, 'ascii')))
  const extensions = tlv(
    0xa3,
    derSeq(
      derSeq(derOid('2.5.29.17'), derOctet(san)),
      // basicConstraints, critical, CA absent => FALSE.
      derSeq(derOid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), derOctet(derSeq())),
    ),
  )

  const tbs = derSeq(
    tlv(0xa0, derInt(2)), // version v3
    derInt(Math.floor(Math.random() * 0x7fffffff) || 1),
    sha256WithRsa,
    name,
    validity,
    name,
    spki,
    extensions,
  )
  const signature = crypto.sign('sha256', tbs, privateKey)
  const certDer = derSeq(tbs, sha256WithRsa, derBitString(signature))

  return {
    certPem: pem('CERTIFICATE', certDer),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

let material: { certPath: string; keyPath: string }
let brokenMaterial: { certPath: string; keyPath: string }
const openHandles: Array<{ close(): Promise<void> | void }> = []

before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-terminator-'))
  const { certPem, keyPem } = selfSigned('tls-test.invalid')
  const certPath = path.join(dir, 'console.crt')
  const keyPath = path.join(dir, 'console.key')
  fs.writeFileSync(certPath, certPem)
  fs.writeFileSync(keyPath, keyPem)
  material = { certPath, keyPath }

  // A DER `.cer` saved over a `.crt`, which is the corruption class that
  // actually happens in the field.
  const badCert = path.join(dir, 'broken.crt')
  const badKey = path.join(dir, 'broken.key')
  fs.writeFileSync(badCert, Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x02, 0x01, 0x00]))
  fs.writeFileSync(badKey, 'not a key at all')
  brokenMaterial = { certPath: badCert, keyPath: badKey }
})

// ⛔ Teardown is part of the deliverable, not housekeeping: a close() that does
// not complete is how a service stop becomes a kill. Every listener this file
// opens is closed here, newest first, and the suite exits on its own — it is
// not forced down with a timer, so a leaked socket shows up as a hang.
after(async () => {
  for (const handle of openHandles.reverse()) await handle.close()
})

function track<T extends { close(): Promise<void> | void }>(handle: T): T {
  openHandles.push(handle)
  return handle
}

interface SeenRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
  upgraded?: boolean
}

interface Upstream {
  port: number
  seen: SeenRequest[]
  close(): Promise<void>
}

/**
 * A trivial loopback console. Echoes what it was asked, records it, and
 * completes a real WebSocket handshake so the upgrade path can be driven
 * end to end.
 *
 * ⛔ Bound on 127.0.0.1 ONLY — never on `::1` and never on all interfaces — so
 * a terminator that reached for `localhost` could not be served by accident on
 * a dual-stack box.
 */
function startFakeUpstream(marker: string): Promise<Upstream> {
  const seen: SeenRequest[] = []
  const upgraded: Duplex[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ method: req.method || '', url: req.url || '', headers: req.headers, body })
      const payload = JSON.stringify({
        marker,
        method: req.method,
        url: req.url,
        body,
        xfProto: req.headers['x-forwarded-proto'] ?? null,
        xfHost: req.headers['x-forwarded-host'] ?? null,
        xfFor: req.headers['x-forwarded-for'] ?? null,
        forwarded: req.headers.forwarded ?? null,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(payload)
    })
  })

  server.on('upgrade', (req, socket) => {
    // An upgraded socket is hijacked out of http.Server's bookkeeping, so
    // closeAllConnections() does not reach it and close() would hang.
    upgraded.push(socket)
    seen.push({
      method: req.method || '',
      url: req.url || '',
      headers: req.headers,
      body: '',
      upgraded: true,
    })
    const key = String(req.headers['sec-websocket-key'] || '')
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.write(`${marker}-WS-READY`)
    socket.on('data', (d: Buffer) => socket.write(`ECHO:${d.toString('utf8')}`))
    socket.on('error', () => socket.destroy())
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: address && typeof address === 'object' ? address.port : 0,
        seen,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of upgraded) socket.destroy()
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

function collectLog(): { log: TerminatorLog; infos: string[]; errors: string[] } {
  const infos: string[] = []
  const errors: string[] = []
  return {
    infos,
    errors,
    log: { info: (m) => infos.push(m), error: (m) => errors.push(m) },
  }
}

function activeConfig(): TlsConfig {
  const config = resolveTlsConfig({
    TLS_CERT_PATH: material.certPath,
    TLS_KEY_PATH: material.keyPath,
  } as TlsEnv)
  assert.equal(config.status, 'active', `fixture certificate did not load: ${config.error}`)
  return config
}

/** A port nothing is listening on, for the dedicated-redirect-port test. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = address && typeof address === 'object' ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

interface Answer {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function request(
  mode: 'https' | 'http',
  port: number,
  opts: { path?: string; method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const common = {
      host: '127.0.0.1',
      port,
      path: opts.path ?? '/',
      method: opts.method ?? 'GET',
      headers: opts.headers,
      // ⛔ node >= 19 defaults the global agent to keepAlive, so without this a
      // client socket outlives the request and the upstream server's close()
      // never calls back — the suite then hangs at teardown, not in a test.
      agent: false as const,
    }
    const req =
      mode === 'https'
        ? https.request({ ...common, rejectUnauthorized: false }, handle)
        : http.request(common, handle)

    function handle(res: http.IncomingMessage): void {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }))
    }

    // ⛔ A CLIENT-SIDE DEADLINE, so a terminator that answers NOTHING fails a
    // named test instead of hanging the suite. Without it, deleting the
    // `socket.unshift` makes every demuxed request wait for ever and the whole
    // file is reported as "cancelled" with zero failures — a mutation that
    // destroys the feature would then look like a flake, not a regression.
    req.setTimeout(4000, () =>
      req.destroy(new Error('the terminator sent no response within 4s')),
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// active: the TLS path
// ─────────────────────────────────────────────────────────────────────────────

test('active: a TLS request is proxied and the response body arrives intact', async () => {
  const upstream = track(await startFakeUpstream('NETVAULT'))
  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'netvault',
      publicPort: 0,
      upstreamPort: upstream.port,
      tls: activeConfig(),
      log,
    }),
  )

  const answer = await request('https', handle.publicPort, { path: '/api/health' })
  assert.equal(answer.status, 200)
  const parsed = JSON.parse(answer.body) as { marker: string; url: string }
  assert.equal(parsed.marker, 'NETVAULT')
  assert.equal(parsed.url, '/api/health')
})

test('active: a large response body is streamed through byte for byte', async () => {
  // Proves the proxy relays rather than truncating or re-encoding: a LogVault
  // CSV export is the real case, and a buffering proxy is an OOM on this box.
  const payload = 'x'.repeat(512 * 1024)
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(payload)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const address = server.address()
  const upstreamPort = address && typeof address === 'object' ? address.port : 0
  track({
    close: () =>
      new Promise<void>((d) => {
        server.closeAllConnections()
        server.close(() => d())
      }),
  })

  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'logvault',
      publicPort: 0,
      upstreamPort,
      tls: activeConfig(),
      log,
    }),
  )
  const answer = await request('https', handle.publicPort, { path: '/export.csv' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.length, payload.length)
  assert.equal(answer.body, payload)
})

// ─────────────────────────────────────────────────────────────────────────────
// active: the same-port plaintext demux
// ─────────────────────────────────────────────────────────────────────────────

test('demux: plaintext on the TLS port gets a 301, not a protocol error', async () => {
  const upstream = track(await startFakeUpstream('NETVAULT'))
  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'netvault',
      publicPort: 0,
      upstreamPort: upstream.port,
      tls: activeConfig(),
      log,
    }),
  )

  // An old `http://host:3000/launcher` bookmark. Without the demux this is not
  // a redirect, it is a connection error with nothing in any log.
  const answer = await request('http', handle.publicPort, {
    path: '/launcher',
    headers: { host: 'console.example.invalid:3000' },
  })
  assert.equal(answer.status, 301)
  assert.equal(
    answer.headers.location,
    `https://console.example.invalid:${handle.publicPort}/launcher`,
  )
  // The redirect is answered by the terminator, never by the console behind it.
  assert.equal(upstream.seen.length, 0)
})

test('demux: the first byte is not lost — the full request line and body survive', async () => {
  // ⛔ THIS IS THE `socket.unshift` TEST. The peeked byte has already been
  // consumed; without pushing it back a ClientHello stops being a ClientHello
  // and `GET /x` arrives as `ET /x`. Both halves of the demux are asserted on
  // the exact bytes, not on a status code.
  const upstream = track(await startFakeUpstream('NETVAULT'))
  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'netvault',
      publicPort: 0,
      upstreamPort: upstream.port,
      tls: activeConfig(),
      log,
    }),
  )

  // (a) the TLS half — the handshake only completes if 0x16 was pushed back,
  //     and the console must see the request verbatim.
  const body = 'first-byte-integrity-POST-body'
  const answer = await request('https', handle.publicPort, {
    method: 'POST',
    path: '/api/sites?q=1&r=2',
    headers: { 'content-type': 'text/plain', 'content-length': String(body.length) },
    body,
  })
  assert.equal(answer.status, 200)
  const seen = upstream.seen.at(-1)
  assert.ok(seen, 'the console behind the terminator saw no request at all')
  assert.equal(seen.method, 'POST', 'the request METHOD lost its first byte')
  assert.equal(seen.url, '/api/sites?q=1&r=2', 'the request TARGET was not relayed verbatim')
  assert.equal(seen.body, body, 'the request BODY was not relayed verbatim')

  // (b) the plaintext half — a dropped 'G' makes this unparseable, so the
  //     terminator answers nothing at all rather than a 301.
  const plain = await request('http', handle.publicPort, {
    path: '/deep/path?keep=everything',
    headers: { host: 'console.example.invalid' },
  })
  assert.equal(plain.status, 301, 'the plaintext half of the demux lost its first byte')
  assert.equal(
    answerPath(String(plain.headers.location)),
    '/deep/path?keep=everything',
    'the redirect target lost characters',
  )
})

function answerPath(location: string): string {
  const parsed = new URL(location)
  return `${parsed.pathname}${parsed.search}`
}

test('demux: a socket that connects and says nothing is closed by the first-byte timeout', async () => {
  // ⛔ Firewalls, load-balancer health probes and port scanners all do exactly
  // this. Without the timeout each one holds a descriptor for ever.
  const upstream = track(await startFakeUpstream('NETVAULT'))
  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'netvault',
      publicPort: 0,
      upstreamPort: upstream.port,
      tls: activeConfig(),
      log,
      firstByteTimeoutMs: 150,
    }),
  )

  const closed = await new Promise<boolean>((resolve) => {
    const socket = net.connect(handle.publicPort, '127.0.0.1')
    const giveUp = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 3000)
    socket.on('close', () => {
      clearTimeout(giveUp)
      resolve(true)
    })
    socket.on('error', () => {
      clearTimeout(giveUp)
      resolve(true)
    })
    // Deliberately never writes a byte.
  })

  assert.equal(closed, true, 'an idle socket was never closed — the first-byte timeout is gone')
  assert.equal(FIRST_BYTE_TIMEOUT_MS > 0, true)
})

// ─────────────────────────────────────────────────────────────────────────────
// active: WebSocket upgrades (SpanVault agent ingest, DDIVault listener)
// ─────────────────────────────────────────────────────────────────────────────

test('active: a WebSocket upgrade completes and both directions stream', async () => {
  const upstream = track(await startFakeUpstream('SPANVAULT'))
  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'spanvault',
      publicPort: 0,
      upstreamPort: upstream.port,
      tls: activeConfig(),
      log,
    }),
  )

  const key = crypto.randomBytes(16).toString('base64')
  const transcript = await new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: handle.publicPort,
      rejectUnauthorized: false,
    })
    let seen = ''
    let pinged = false
    const giveUp = setTimeout(() => {
      socket.destroy()
      reject(new Error(`upgrade never completed; saw: ${JSON.stringify(seen)}`))
    }, 5000)
    socket.on('secureConnect', () => {
      socket.write(
        'GET /ws/agent HTTP/1.1\r\n' +
          'Host: console.example.invalid\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    socket.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8')
      if (!pinged && seen.includes('SPANVAULT-WS-READY')) {
        pinged = true
        socket.write('PING')
      }
      if (seen.includes('ECHO:PING')) {
        clearTimeout(giveUp)
        socket.destroy()
        resolve(seen)
      }
    })
    socket.on('error', (err) => {
      clearTimeout(giveUp)
      reject(err)
    })
  })

  const expectedAccept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  assert.match(transcript, /^HTTP\/1\.1 101 Switching Protocols/)
  // Header NAMES are case-insensitive and node lower-cases what it parsed, so
  // the comparison is too; the VALUE must be byte-exact or the handshake the
  // client computed would not verify.
  assert.ok(
    transcript.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`),
    `the 101 response headers were not relayed; saw: ${JSON.stringify(transcript)}`,
  )
  assert.ok(transcript.includes('ECHO:PING'), 'client -> console bytes did not reach the console')

  const upgraded = upstream.seen.find((s) => s.upgraded)
  assert.ok(upgraded, 'the console never saw an upgrade request')
  assert.equal(upgraded.url, '/ws/agent')
  assert.equal(upgraded.headers['x-forwarded-proto'], 'https')
})

// ─────────────────────────────────────────────────────────────────────────────
// X-Forwarded-*: the hardening question
// ─────────────────────────────────────────────────────────────────────────────

test('forwarded: a client-supplied X-Forwarded-Proto/Host/For is overwritten, never trusted', async () => {
  // ⛔ `lib/publicUrl.ts`'s resolveOrigin trusts x-forwarded-host after only a
  // shape check, and the SSO handoff routes put a signed token in a redirect
  // built from it. If the terminator relayed or APPENDED to a client value, a
  // client that can reach the terminator could steer that redirect.
  const upstream = track(await startFakeUpstream('NETVAULT'))
  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'netvault',
      publicPort: 0,
      upstreamPort: upstream.port,
      tls: activeConfig(),
      log,
    }),
  )

  const answer = await request('https', handle.publicPort, {
    path: '/api/sso/logvault',
    headers: {
      host: 'console.example.invalid',
      'x-forwarded-proto': 'http',
      'x-forwarded-host': 'attacker.example.invalid',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-port': '80',
      'x-real-ip': '203.0.113.7',
      forwarded: 'host=attacker.example.invalid;proto=http',
    },
  })

  const parsed = JSON.parse(answer.body) as Record<string, string | null>
  assert.equal(parsed.xfProto, 'https', 'a client downgraded X-Forwarded-Proto')
  assert.equal(
    parsed.xfHost,
    'console.example.invalid',
    'a client injected X-Forwarded-Host',
  )
  assert.equal(parsed.forwarded, null, 'the RFC 7239 Forwarded header was relayed')

  const seen = upstream.seen.at(-1)
  assert.ok(seen)
  // Overwritten, NOT appended: a comma list is the failure mode, because
  // resolveOrigin reads the first element of the proto and the whole host.
  assert.equal(String(seen.headers['x-forwarded-proto']).includes(','), false)
  assert.equal(String(seen.headers['x-forwarded-host']).includes(','), false)
  assert.equal(String(seen.headers['x-forwarded-for']).includes('203.0.113.7'), false)
  assert.equal(String(seen.headers['x-forwarded-port']), String(handle.publicPort))
  assert.equal(seen.headers['x-real-ip'], undefined)
})

test('forwarded: TLS_PUBLIC_HOST pins X-Forwarded-Host instead of echoing the client Host', async () => {
  const upstream = track(await startFakeUpstream('NETVAULT'))
  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'netvault',
      publicPort: 0,
      upstreamPort: upstream.port,
      tls: activeConfig(),
      log,
      publicHost: 'console.pinned.invalid',
    }),
  )

  const answer = await request('https', handle.publicPort, {
    headers: { host: 'anything.example.invalid', 'x-forwarded-host': 'attacker.example.invalid' },
  })
  const parsed = JSON.parse(answer.body) as Record<string, string | null>
  assert.equal(parsed.xfHost, 'console.pinned.invalid')
})

// ─────────────────────────────────────────────────────────────────────────────
// the three transport states
// ─────────────────────────────────────────────────────────────────────────────

test('failed: serves plain HTTP and logs a loud error banner on every start', async () => {
  const upstream = track(await startFakeUpstream('NETVAULT'))
  const { log, infos, errors } = collectLog()
  const publicPort = await freePort()

  const handles = await startTerminator(
    {
      TLS_CERT_PATH: brokenMaterial.certPath,
      TLS_KEY_PATH: brokenMaterial.keyPath,
    } as TlsEnv,
    {
      log,
      upstreams: [
        { app: 'netvault', publicPortDefault: publicPort, upstreamPortDefault: upstream.port },
      ],
    },
  )
  for (const handle of handles) track(handle)

  assert.equal(handles.length, 1)
  assert.equal(handles[0].status, 'failed')

  // It is SERVING — a broken certificate degrades, it does not take the console
  // down, because on a monitoring suite an outage means nobody can see the
  // network.
  const answer = await request('http', handles[0].publicPort, { path: '/api/health' })
  assert.equal(answer.status, 200)
  assert.equal((JSON.parse(answer.body) as { marker: string }).marker, 'NETVAULT')

  // ⛔ And it is LOUD. Degrading is only safe because `failed` is never silent.
  assert.ok(errors.length > 0, '`failed` produced NOTHING on the error channel')
  const banner = errors.join('\n')
  assert.match(banner, /CONFIGURED BUT NOT ACTIVE/)
  assert.match(banner, /NOT encrypted/)
  assert.ok(
    !infos.join('\n').includes('CONFIGURED BUT NOT ACTIVE'),
    '`failed` was announced on the info channel, where it reads as normal',
  )
})

test('disabled: serves plain HTTP and says nothing on the error channel', async () => {
  const upstream = track(await startFakeUpstream('DDIVAULT'))
  const { log, infos, errors } = collectLog()
  const publicPort = await freePort()

  const handles = await startTerminator({} as TlsEnv, {
    log,
    upstreams: [
      { app: 'ddivault', publicPortDefault: publicPort, upstreamPortDefault: upstream.port },
    ],
  })
  for (const handle of handles) track(handle)

  assert.equal(handles[0].status, 'disabled')
  const answer = await request('http', handles[0].publicPort, { path: '/api/health' })
  assert.equal(answer.status, 200)
  assert.equal((JSON.parse(answer.body) as { marker: string }).marker, 'DDIVAULT')

  // ⛔ `disabled` is NOT an error — it is how the whole suite has shipped for
  // its entire life. Shouting about it is how an operator learns to ignore the
  // channel that `failed` needs.
  assert.deepEqual(errors, [])
  assert.match(infos.join('\n'), /not configured/)
})

test('failed: a WebSocket upgrade still works on the degraded plain-HTTP port', async () => {
  const upstream = track(await startFakeUpstream('SPANVAULT'))
  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'spanvault',
      publicPort: 0,
      upstreamPort: upstream.port,
      tls: resolveTlsConfig({
        TLS_CERT_PATH: brokenMaterial.certPath,
        TLS_KEY_PATH: brokenMaterial.keyPath,
      } as TlsEnv),
      log,
    }),
  )
  assert.equal(handle.status, 'failed')

  const key = crypto.randomBytes(16).toString('base64')
  const seen = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(handle.publicPort, '127.0.0.1', () => {
      socket.write(
        'GET /ws/agent HTTP/1.1\r\n' +
          'Host: console.example.invalid\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let text = ''
    const giveUp = setTimeout(() => {
      socket.destroy()
      reject(new Error(`upgrade never completed; saw: ${JSON.stringify(text)}`))
    }, 5000)
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      if (text.includes('SPANVAULT-WS-READY')) {
        clearTimeout(giveUp)
        socket.destroy()
        resolve(text)
      }
    })
    socket.on('error', (err) => {
      clearTimeout(giveUp)
      reject(err)
    })
  })
  assert.match(seen, /^HTTP\/1\.1 101 Switching Protocols/)
  const upgraded = upstream.seen.find((s) => s.upgraded)
  assert.ok(upgraded)
  assert.equal(upgraded.headers['x-forwarded-proto'], 'http')
})

// ─────────────────────────────────────────────────────────────────────────────
// the dedicated redirect port, and per-app layout
// ─────────────────────────────────────────────────────────────────────────────

test('active: the dedicated plain-HTTP port 301s to the TLS port', async () => {
  const upstream = track(await startFakeUpstream('NETVAULT'))
  const { log } = collectLog()
  const redirectPort = await freePort()
  const handle = track(
    await startUpstream({
      app: 'netvault',
      publicPort: 0,
      upstreamPort: upstream.port,
      httpRedirectPort: redirectPort,
      tls: activeConfig(),
      log,
    }),
  )
  assert.equal(handle.httpRedirectPort, redirectPort)

  const answer = await request('http', redirectPort, {
    path: '/sites',
    headers: { host: 'console.example.invalid' },
  })
  assert.equal(answer.status, 301)
  assert.equal(answer.headers.location, `https://console.example.invalid:${handle.publicPort}/sites`)
})

test('layout: two consoles on different ports each reach their OWN upstream', async () => {
  // ⛔ Nothing may be hardcoded to one app. Each listener is a pair
  // (public port -> loopback port) and the pairs must not cross.
  const hub = track(await startFakeUpstream('NETVAULT'))
  const satellite = track(await startFakeUpstream('LOGVAULT'))
  const { log } = collectLog()
  const config = activeConfig()

  const first = track(
    await startUpstream({ app: 'netvault', publicPort: 0, upstreamPort: hub.port, tls: config, log }),
  )
  const second = track(
    await startUpstream({
      app: 'logvault',
      publicPort: 0,
      upstreamPort: satellite.port,
      tls: config,
      log,
    }),
  )
  assert.notEqual(first.publicPort, second.publicPort)

  const a = JSON.parse((await request('https', first.publicPort)).body) as { marker: string }
  const b = JSON.parse((await request('https', second.publicPort)).body) as { marker: string }
  assert.equal(a.marker, 'NETVAULT')
  assert.equal(b.marker, 'LOGVAULT')
})

test('layout: every suite console is planned from its own env keys, and PORT never leaks', () => {
  const plan = resolveUpstreamPlan({
    TLS_CERT_PATH: material.certPath,
    TLS_KEY_PATH: material.keyPath,
    // ⛔ The terminator service could inherit this from anywhere. If it reached
    // resolveTlsConfig (which falls back HTTPS_PORT || PORT) all four consoles
    // would resolve onto 3000 and three would fail to bind.
    PORT: '3000',
    LOGVAULT_HTTPS_PORT: '4444',
    LOGVAULT_UPSTREAM_PORT: '14444',
  } as TlsEnv)

  assert.deepEqual(
    plan.map((entry) => [entry.app, entry.publicPort, entry.upstreamPort]),
    [
      ['netvault', 3000, 13000],
      ['logvault', 4444, 14444],
      ['ddivault', 3006, 13006],
      ['spanvault', 3008, 13008],
    ],
  )
  // ⛔ The redirect port follows the app's own DEFAULT, not an overridden
  // HTTPS_PORT — an operator who moves a console's public port is telling us
  // one number, and inferring a second from it would bind a port nobody asked
  // for. logvault is on 4444 here and still redirects from 3084.
  assert.deepEqual(
    plan.map((entry) => entry.httpRedirectPort),
    [3080, 3084, 3086, 3088],
  )
  for (const entry of plan) assert.equal(entry.tls.status, 'active')

  // The per-app projection must not pass PORT through at all.
  assert.equal(upstreamEnv('ddivault', { PORT: '3000' } as TlsEnv).PORT, undefined)
  assert.equal(TLS_HANDSHAKE_FIRST_BYTE, 0x16)
  assert.equal(UPSTREAM_HOST, '127.0.0.1')
})

test('layout: a public port already in use fails only that console, not the suite', async () => {
  const hub = track(await startFakeUpstream('NETVAULT'))
  const satellite = track(await startFakeUpstream('LOGVAULT'))
  const { log, errors } = collectLog()

  const taken = net.createServer()
  await new Promise<void>((done) => taken.listen(0, () => done()))
  const takenAddress = taken.address()
  const takenPort = takenAddress && typeof takenAddress === 'object' ? takenAddress.port : 0
  track({
    close: () =>
      // net.Server (unlike http.Server) has no closeAllConnections; nothing
      // ever connected to this one, it only held the port.
      new Promise<void>((d) => taken.close(() => d())),
  })

  const freeForSatellite = await freePort()
  const handles: UpstreamHandle[] = await startTerminator({} as TlsEnv, {
    log,
    upstreams: [
      { app: 'netvault', publicPortDefault: takenPort, upstreamPortDefault: hub.port },
      { app: 'logvault', publicPortDefault: freeForSatellite, upstreamPortDefault: satellite.port },
    ],
  })
  for (const handle of handles) track(handle)

  assert.equal(handles.length, 1)
  assert.equal(handles[0].app, 'logvault')
  assert.match(errors.join('\n'), /netvault: could not listen on/)
  const answer = await request('http', handles[0].publicPort)
  assert.equal((JSON.parse(answer.body) as { marker: string }).marker, 'LOGVAULT')
})

test('a dead upstream answers 502 rather than hanging the browser', async () => {
  const dead = await freePort()
  const { log } = collectLog()
  const handle = track(
    await startUpstream({
      app: 'netvault',
      publicPort: 0,
      upstreamPort: dead,
      tls: activeConfig(),
      log,
    }),
  )
  const answer = await request('https', handle.publicPort, { path: '/' })
  assert.equal(answer.status, 502)
  assert.match(answer.body, /netvault console behind this port is not responding/)
})

// ─────────────────────────────────────────────────────────────────────────────
// the launcher (installer/terminator/start.mjs)
// ─────────────────────────────────────────────────────────────────────────────

test('launcher: a Node that cannot execute TypeScript is recognised, and nothing else is', () => {
  // ⛔ This branch CANNOT be reached on any Node that can run this test file at
  // all, so without driving it from a synthetic error it would be a guard that
  // is never exercised anywhere — the shape this codebase names most often.
  assert.equal(isTypeScriptUnsupported({ code: 'ERR_UNKNOWN_FILE_EXTENSION' }), true)
  assert.equal(
    isTypeScriptUnsupported(
      new Error('Unknown file extension ".ts" for /opt/app/installer/terminator/x.ts'),
    ),
    true,
  )

  // Anything else must be RETHROWN, not swallowed into "upgrade your Node":
  // a wrong diagnosis sends the next person to fix the wrong thing.
  assert.equal(isTypeScriptUnsupported(null), false)
  assert.equal(isTypeScriptUnsupported(undefined), false)
  assert.equal(isTypeScriptUnsupported(new Error('EADDRINUSE: address already in use')), false)
  assert.equal(isTypeScriptUnsupported({ code: 'ERR_MODULE_NOT_FOUND' }), false)
  assert.equal(
    isTypeScriptUnsupported(new Error('Unknown file extension ".tsx" for /x/y.tsx')),
    false,
  )
})

test('launcher: the refusal names the version, the fix, and that it did NOT serve plaintext', () => {
  const message = unsupportedRuntimeMessage('v20.19.0')
  assert.match(message, /NOT STARTED/)
  assert.ok(message.includes('v20.19.0'), 'the refusal does not say which Node it measured')
  // ⛔ The single most dangerous reading of a TLS component that did not start
  // is "it fell back to HTTP and is fine", so the refusal says it did not.
  assert.match(message, /NOT fallen back to plain HTTP/)
  assert.match(message, /Node 22\.18 LTS or newer/)
})

test('launcher: `node start.mjs` actually binds and proxies — an import alone would not', () => {
  // ⛔ THE REGRESSION THIS PINS WAS REAL AND SILENT. The first launcher only
  // `await import()`ed the terminator, whose own entry guard fires only when IT
  // is argv[1] — so the process loaded cleanly, bound nothing, logged nothing
  // and exited 0. Under NSSM that is a service reporting Running with no
  // listener behind it, which is the worst available outcome for a TLS
  // component. Nothing short of launching the real process catches it.
  return (async () => {
    const upstream = track(await startFakeUpstream('NETVAULT'))
    const ports = {
      netvault: await freePort(),
      logvault: await freePort(),
      ddivault: await freePort(),
      spanvault: await freePort(),
    }
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), 'installer', 'terminator', 'start.mjs')],
      {
        env: {
          ...process.env,
          // Every console moved off its real port: a test must not take 3000.
          NETVAULT_HTTPS_PORT: String(ports.netvault),
          LOGVAULT_HTTPS_PORT: String(ports.logvault),
          DDIVAULT_HTTPS_PORT: String(ports.ddivault),
          SPANVAULT_HTTPS_PORT: String(ports.spanvault),
          NETVAULT_UPSTREAM_PORT: String(upstream.port),
          TLS_CERT_PATH: '',
          TLS_KEY_PATH: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    // ⛔ Attached BEFORE anything can exit. Registering an 'exit' listener in
    // the finally block loses the race whenever the child has ALREADY died —
    // the await then never settles and a failing assertion becomes a hung
    // suite, which is how a broken launcher reads as a flake.
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    let log = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      log += c
    })
    child.stderr.on('data', (c: string) => {
      log += c
    })

    try {
      let answer: Answer | null = null
      const deadline = Date.now() + 15000
      // A child that has exited is never going to answer; stop waiting on it.
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        try {
          answer = await request('http', ports.netvault, { path: '/api/health' })
          break
        } catch {
          await new Promise((r) => setTimeout(r, 200))
        }
      }
      assert.ok(
        answer,
        `the launched terminator never answered on ${ports.netvault}; it logged: ${log}`,
      )
      assert.equal(answer.status, 200)
      assert.equal((JSON.parse(answer.body) as { marker: string }).marker, 'NETVAULT')
      assert.match(log, /netvault: listening on http:/)
    } finally {
      child.kill('SIGKILL')
      await exited
    }
  })()
})
