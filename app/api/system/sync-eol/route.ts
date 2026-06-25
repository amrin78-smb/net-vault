import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { syncFromFeed } from '@/lib/eolFeed'

/**
 * POST /api/system/sync-eol — pull the central NocVault EOL feed into the local
 * eol_seed catalog. The automated, weekly counterpart to the EOL Intelligence
 * page's manual "Sync from EOL feed" button (which posts to
 * /api/admin/eol-seed/sync). Driven by the NetVault-SyncEol scheduled task.
 *
 * Auth (either):
 *   - Authorization: Bearer ${CRON_SECRET}  (the scheduled task / cron), OR
 *   - an authenticated super_admin session.
 * 401 if neither, 403 if a session exists but isn't super_admin.
 *
 * SAFETY: syncFromFeed writes ONLY to eol_seed (never devices) and verifies the
 * feed's Ed25519 signature + sha256 before a single row is written. Enrichment
 * stays a separate step — the daily NetVault-EnrichEol task applies the refreshed
 * seed to devices on its next run (the sync task is scheduled just ahead of it).
 *
 * Offline / air-gapped installs: a fetch/verify failure is reported as a soft
 * { ok:false, skipped:true } 200 (not a 500), so the weekly scheduler doesn't
 * treat the expected "no internet" case as a failure; the bundled seed floor
 * (lib/eolSeed.ts) remains in place untouched.
 */
export async function POST(req: NextRequest) {
  // 1) Cron secret path.
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get('authorization') || ''
  const cronOk = !!secret && provided === `Bearer ${secret}`

  // 2) Session path (only checked when the cron secret didn't match).
  if (!cronOk) {
    const session = await getServerSession(authOptions)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const role = (session.user as { role?: string } | undefined)?.role
    if (role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  try {
    const result = await syncFromFeed()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    // Expected when offline/air-gapped or the feed is unreachable — log and report
    // a soft skip so the weekly scheduled task doesn't flag it as a failure. The
    // bundled seed floor still serves matching; nothing is changed on failure.
    const reason = err instanceof Error ? err.message : 'sync failed'
    console.warn('[system/sync-eol] skipped:', reason)
    return NextResponse.json({ ok: false, skipped: true, reason }, { status: 200 })
  }
}
