import { timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'

/**
 * Shared auth for the internal scheduled-task endpoints (`/api/system/sync-eol`,
 * `/api/system/enrich-eol`, `/api/system/health-snapshot`), which the Windows
 * Task Scheduler calls with `Authorization: Bearer $CRON_SECRET`.
 *
 * Compared in CONSTANT TIME. A plain `===` on a secret short-circuits at the first
 * differing byte, so the time it takes to reject leaks how much of the prefix was
 * right — enough to recover the secret byte-by-byte over many requests from an
 * attacker who can reach the endpoint (these routes are on the LAN, unauthenticated
 * by design, and a valid secret triggers a full EOL sync/enrichment).
 *
 * The length check before `timingSafeEqual` is required (it throws on differing
 * lengths) and leaks only the secret's LENGTH, which is fixed by the installer and
 * not sensitive.
 *
 * Returns false when CRON_SECRET is unset, so a misconfigured install fails closed
 * rather than accepting any caller.
 */
export function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false

  const provided = Buffer.from(req.headers.get('authorization') || '', 'utf8')
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8')
  if (provided.length !== expected.length) return false

  return timingSafeEqual(provided, expected)
}
