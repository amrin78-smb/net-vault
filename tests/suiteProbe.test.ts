import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  probeStatus,
  probeJson,
  PROBE_ATTEMPTS,
  PROBE_TIMEOUT_MS,
  type FetchLike,
} from '../lib/suiteProbe.ts'

// The timeout path is exercised with a short budget so the suite does not sit out
// the real 6 s twice per case. PROBE_TIMEOUT_MS itself is asserted at the bottom.
const FAST = 50

/** A fetch stand-in that answers with a given body/ok. */
function answers(body: unknown, ok = true): { impl: FetchLike; calls: () => number } {
  let n = 0
  const impl: FetchLike = async () => {
    n++
    return { ok, json: async () => body }
  }
  return { impl, calls: () => n }
}

/** A fetch stand-in that refuses the connection, as a dead app does. */
function refuses(): { impl: FetchLike; calls: () => number } {
  let n = 0
  const impl: FetchLike = async () => {
    n++
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:13004'), { code: 'ECONNREFUSED' })
  }
  return { impl, calls: () => n }
}

/**
 * A fetch stand-in that never answers, so the AbortController fires — a SLOW app,
 * which is the case this whole module exists to tell apart from a dead one.
 * It rejects only once aborted, exactly as a real fetch does.
 */
function hangs(): { impl: FetchLike; calls: () => number } {
  let n = 0
  const impl: FetchLike = (_url, init) => {
    n++
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
    })
  }
  return { impl, calls: () => n }
}

// ── the distinction this module was written for ─────────────────────────────

test('a healthy body is Healthy', async () => {
  const f = answers({ status: 'ok', version: '2.39.2' })
  assert.equal(await probeStatus('http://x/api/health', f.impl), 'Healthy')
  assert.equal(f.calls(), 1, 'a good answer must not be retried')
})

test('⛔ a SLOW app is Warning, not Unavailable', async () => {
  // This is the whole point. On 2026-11-09 SpanVault answered the hub's probe in
  // 7-8 ms and still rendered as "Unavailable", because the old code mapped every
  // failure — timeout included — onto the same value, and the launcher turns any
  // 'Unavailable' into an overall "Critical" for the suite. If this assertion is
  // ever "simplified" back to 'Unavailable', that bug is back.
  const f = hangs()
  assert.equal(await probeStatus('http://x/api/health', f.impl, FAST), 'Warning')
  assert.equal(f.calls(), PROBE_ATTEMPTS, 'a timeout is retried before being reported')
})

test('⛔ a REFUSED connection is still Unavailable', async () => {
  // The counterpart guard: softening a genuinely dead app to 'Warning' would hide a
  // real outage behind an amber pill. Only a timeout earns the benefit of the doubt.
  const f = refuses()
  assert.equal(await probeStatus('http://x/api/health', f.impl), 'Unavailable')
  assert.equal(f.calls(), PROBE_ATTEMPTS)
})

// ── answered-but-unhappy cases ──────────────────────────────────────────────

test('a non-2xx answer is Warning and is NOT retried', async () => {
  const f = answers(null, false)
  assert.equal(await probeStatus('http://x/api/health', f.impl), 'Warning')
  assert.equal(f.calls(), 1, 'a 500 will still be a 500 next time — do not double the load')
})

test('a 200 whose body is not status:ok is Warning', async () => {
  assert.equal(await probeStatus('http://x', answers({ status: 'degraded' }).impl), 'Warning')
  assert.equal(await probeStatus('http://x', answers(null).impl), 'Warning')
  assert.equal(await probeStatus('http://x', answers('not json at all').impl), 'Warning')
})

test('a body that cannot be parsed is Warning, not a throw', async () => {
  const impl: FetchLike = async () => ({ ok: true, json: async () => { throw new Error('bad json') } })
  assert.equal(await probeStatus('http://x', impl), 'Warning')
})

// ── one retry really does recover a blip ────────────────────────────────────

test('a single blip is recovered by the retry', async () => {
  let n = 0
  const impl: FetchLike = async () => {
    n++
    if (n === 1) throw new Error('socket hang up')
    return { ok: true, json: async () => ({ status: 'ok' }) }
  }
  assert.equal(await probeStatus('http://x/api/health', impl), 'Healthy')
  assert.equal(n, 2)
})

// ── probeJson shares the policy ─────────────────────────────────────────────

test('probeJson returns the body, and null for every failure', async () => {
  assert.deepEqual(
    await probeJson('http://x/api/stats', answers({ logs_today: 0 }).impl),
    { logs_today: 0 },
  )
  // ⛔ zeros are DATA, not a failure: on 2026-11-09 LogVault's genuine 0/0/0 was the
  // evidence that its /api/stats probe had SUCCEEDED while its health probe had not.
  assert.deepEqual(
    await probeJson('http://x/api/stats', answers({ logs_today: 0, log_sources: 0 }).impl),
    { logs_today: 0, log_sources: 0 },
  )
  assert.equal(await probeJson('http://x/api/stats', refuses().impl), null)
  assert.equal(await probeJson('http://x/api/stats', hangs().impl, FAST), null)
  assert.equal(await probeJson('http://x/api/stats', answers({}, false).impl), null)
})

// ── the budget itself ───────────────────────────────────────────────────────

test('the probe budget leaves real headroom over a measured slow endpoint', () => {
  // LogVault's /api/health measured 1.23-2.80 s live under the 3000 ms budget it
  // used to have — inside the noise band of its own deadline. The query behind it
  // is fixed (~25 ms now), but the budget must stay clear of that old range so the
  // next slow endpoint does not silently reproduce this.
  assert.ok(PROBE_TIMEOUT_MS >= 5000, 'probe budget must stay well clear of ~3 s')
  assert.ok(PROBE_ATTEMPTS >= 2, 'a single blip must not condemn an app')
})
