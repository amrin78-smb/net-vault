// Shared probe policy for the hub's two cross-app aggregators
// (app/api/suite/health and app/api/suite/stats).
//
// ⛔ A TIMEOUT IS NOT A DEAD APP, AND THIS USED TO CALL IT ONE.
// Both aggregators gave each sibling ONE `fetch` with a 3000 ms AbortController
// and treated every failure identically — a refused connection, a TLS error and a
// slow-but-correct answer all became 'Unavailable', which the launcher maps to an
// overall "Critical" for the whole suite.
//
// Measured on production 2026-11-09, from a user report that the hub "cannot check
// health for logvault and spanvault":
//   - SpanVault's own request log recorded BOTH probes arriving, and answered them
//     (its /api/health is `SELECT 1`, 7-8 ms), at the exact second the launcher drew
//     it as Unavailable with em-dashes for every tile.
//   - LogVault answered in 1.23-2.80 s against the 3000 ms budget — i.e. it lived
//     inside the noise band of its own deadline and crossed it roughly hourly.
//   - Both apps were entirely healthy the whole time.
// The page load that triggers these probes ALSO ran a ~2 s partition-planning query
// against logvault (app/api/hub/alerts), so the deadline was under pressure from the
// hub's own work. That query is fixed too, but the probe must not be this brittle.
//
// Policy, in one place so the two aggregators cannot drift apart:
//   - a longer budget,
//   - one retry, because a single blip should not condemn an app,
//   - and a TIMEOUT is reported as 'Warning' (reached, too slow) rather than
//     'Unavailable' (could not be reached at all).

export type AppStatus = 'Healthy' | 'Warning' | 'Unavailable'

export const PROBE_TIMEOUT_MS = 6000
export const PROBE_ATTEMPTS = 2

/** The slice of `fetch` these probes use, so tests can supply their own. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; cache: 'no-store' },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

type Outcome =
  | { answered: true; ok: boolean; body: unknown }
  | { answered: false; timedOut: boolean }

async function attempt(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Outcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) return { answered: true, ok: false, body: null }
    const body = await res.json().catch(() => null)
    return { answered: true, ok: true, body }
  } catch {
    // ⛔ `controller.signal.aborted` is the discriminator, NOT `err.name`. The error
    // a fetch rejects with on abort is not named consistently across runtimes and
    // versions, and reading the name alone misfiles a genuine refusal as a timeout
    // on whichever one disagrees — which would put a truly dead app back in the
    // 'Warning' bucket and hide a real outage. The signal is ours and is exact.
    return { answered: false, timedOut: controller.signal.aborted }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe a sibling until it answers or the attempts run out.
 * An HTTP answer — even a 500 — is a definite answer and is never retried; only a
 * failure to obtain one is worth a second look.
 */
async function probe(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Outcome> {
  let last: { answered: false; timedOut: boolean } = { answered: false, timedOut: false }
  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    const outcome = await attempt(url, fetchImpl, timeoutMs)
    if (outcome.answered) return outcome
    last = outcome
  }
  return last
}

/** Health verdict for one sibling app. Never throws. */
export async function probeStatus(
  url: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  // Overridable so the tests can exercise the timeout path without waiting the
  // real budget out twice per case. Production callers never pass it.
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<AppStatus> {
  const outcome = await probe(url, fetchImpl, timeoutMs)
  if (!outcome.answered) return outcome.timedOut ? 'Warning' : 'Unavailable'
  if (!outcome.ok) return 'Warning'
  const body = outcome.body as { status?: unknown } | null
  return body && body.status === 'ok' ? 'Healthy' : 'Warning'
}

/** Parsed JSON body for one sibling app, or null if it could not be obtained. */
export async function probeJson(
  url: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<unknown | null> {
  const outcome = await probe(url, fetchImpl, timeoutMs)
  if (!outcome.answered || !outcome.ok) return null
  return outcome.body
}
