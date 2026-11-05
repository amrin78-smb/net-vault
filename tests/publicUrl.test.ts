import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveOrigin } from '../lib/publicUrl.ts'

const FALLBACK = 'http://fallback.example.com:3000'

/** A NextRequest stand-in: resolveOrigin reads only `headers.get` and `nextUrl.protocol`. */
function req(headers: Record<string, string>, protocol = 'http:'): any {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { headers: { get: (k: string) => lower.get(k.toLowerCase()) ?? null }, nextUrl: { protocol } }
}

// ── status quo: no allow-list configured ────────────────────────────────────

test('with TRUST_PROXY_HEADERS unset, a forwarded host is still honoured', () => {
  // ⛔ Pinned deliberately. The tempting hardening default — ignore proxy
  // headers unless a proxy is declared — would make the app conclude `http`
  // behind the TLS terminator (which reaches it over plain HTTP on loopback),
  // build http:// cross-app URLs over a TLS deployment, and bounce every
  // sign-in with no error anywhere.
  const o = resolveOrigin(req({ host: 'internal:3000', 'x-forwarded-host': 'nv.example.com', 'x-forwarded-proto': 'https' }), null, FALLBACK, {})
  assert.equal(o, 'https://nv.example.com')
})

test('the forwarded proto is what carries https through the terminator', () => {
  const o = resolveOrigin(req({ host: 'nv.example.com', 'x-forwarded-proto': 'https' }), 3008, FALLBACK, {})
  assert.equal(o, 'https://nv.example.com:3008')
})

test('no usable host falls back, never throws', () => {
  assert.equal(resolveOrigin(req({}), null, FALLBACK, {}), FALLBACK)
  assert.equal(resolveOrigin(req({ host: '  ' }), null, FALLBACK, {}), FALLBACK)
  assert.equal(resolveOrigin(req({ host: 'bad host!' }), null, FALLBACK, {}), FALLBACK)
})

test('a non-http(s) forwarded proto falls back rather than building a weird scheme', () => {
  assert.equal(resolveOrigin(req({ host: 'nv.example.com', 'x-forwarded-proto': 'javascript' }), null, FALLBACK, {}), FALLBACK)
})

// ── the allow-list ──────────────────────────────────────────────────────────

const ENV = { TRUST_PROXY_HEADERS: 'nv.example.com, other.example.com' } as any

test('an allowed forwarded host is honoured', () => {
  const o = resolveOrigin(req({ host: 'internal:3000', 'x-forwarded-host': 'nv.example.com', 'x-forwarded-proto': 'https' }), null, FALLBACK, ENV)
  assert.equal(o, 'https://nv.example.com')
})

test('a forwarded host NOT on the list is DISCARDED, falling back to the real Host', () => {
  // ⛔ Discarded, not refused: a misconfigured allow-list must not become an
  // outage on every page that builds a cross-app link.
  const o = resolveOrigin(req({ host: 'nv.example.com:3000', 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https' }), null, FALLBACK, ENV)
  assert.equal(o, 'https://nv.example.com', 'the attacker-supplied host must not survive')
})

test('the allow-list ignores case and a port on BOTH sides', () => {
  // \u26d4 THE ENTRY IS MIXED-CASE ON PURPOSE. With a lowercase allow-list only
  // the comparison side's toLowerCase() is exercised, so dropping it from the
  // LIST-PARSING side changes nothing and the test passes with half the guard
  // deleted \u2014 which is exactly what the mutation sweep caught here.
  const env = { TRUST_PROXY_HEADERS: 'NV.Example.COM:3000, other.example.com' } as any
  assert.equal(
    resolveOrigin(req({ host: 'fallback.example.com', 'x-forwarded-host': 'nv.example.com' }), null, FALLBACK, env),
    'http://nv.example.com',
    'a lowercase forwarded host must match a mixed-case allow-list entry',
  )
  assert.equal(
    resolveOrigin(req({ host: 'fallback.example.com', 'x-forwarded-host': 'NV.EXAMPLE.COM:3000' }), null, FALLBACK, env),
    'http://NV.EXAMPLE.COM',
    'and an upper-case one must too, port and all',
  )
})

test('an allow-list of only whitespace behaves as unset, not as deny-all', () => {
  const o = resolveOrigin(req({ host: 'a.example.com', 'x-forwarded-host': 'b.example.com' }), null, FALLBACK, { TRUST_PROXY_HEADERS: ' , ,' })
  assert.equal(o, 'http://b.example.com')
})
