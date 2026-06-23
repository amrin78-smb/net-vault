import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { ensureEolSchema, loadDevices, loadSeedRows, matchDevice, normalizeForMatch } from '@/lib/eolEnrich'

async function requireSuperAdmin() {
  const session = await getServerSession(authOptions)
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const user = session.user as { id?: string; role?: string }
  if (user.role !== 'super_admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { user }
}

/**
 * POST /api/admin/eol-seed/add-all-unmatched — bulk "Add all to seed".
 *
 * Adds EVERY currently-unmatched device model to the eol_seed table as a
 * DATELESS placeholder (confidence 'medium'), so the whole fleet is tracked
 * without clicking "Add to seed" per row. Uses the same normalizeForMatch /
 * matchDevice as the enrichment engine, so each added entry's model_normalized
 * actually matches its devices. Skips blank/empty model names. Dates still
 * require research/curation — this only tracks the models. super_admin only.
 *
 * Response: { ok, added, skippedBlank, distinctUnmatched }
 */
export async function POST() {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error

  try {
    const init = await ensureEolSchema()
    const [seeds, devices] = await Promise.all([loadSeedRows(), loadDevices()])

    // Normalized keys already represented in the seed (primary + aliases).
    const existing = new Set<string>()
    for (const s of seeds) {
      if (s.model_normalized) existing.add(s.model_normalized)
      for (const a of s.aliases) if (a) existing.add(a)
    }

    const addedBy = guard.user.id ? `user:${guard.user.id}` : 'bulk'

    // Collect distinct unmatched models, keyed by normalized key.
    const toAdd = new Map<string, { vendor: string; model_raw: string }>()
    let skippedBlank = 0
    for (const d of devices) {
      const norm = normalizeForMatch(d.brand, d.model)
      if (!norm) { skippedBlank++; continue }            // blank/empty model name
      if (existing.has(norm) || toAdd.has(norm)) continue // already covered or queued
      const m = matchDevice(norm, seeds, init.fuzzyAvailable)
      if (m.seed) continue                                // already matched by a seed entry
      toAdd.set(norm, { vendor: d.brand || 'Unknown', model_raw: d.model || norm })
    }

    let added = 0
    for (const [norm, v] of toAdd) {
      await query(
        `INSERT INTO eol_seed (vendor, model_raw, model_normalized, aliases, confidence, added_by)
         VALUES ($1, $2, $3, '{}', 'medium', $4)`,
        [v.vendor, v.model_raw, norm, addedBy]
      )
      added++
    }

    return NextResponse.json({ ok: true, added, skippedBlank, distinctUnmatched: toAdd.size })
  } catch (err) {
    console.error('[admin/eol-seed/add-all-unmatched POST]', err)
    return NextResponse.json({ error: 'Failed to bulk-add unmatched models' }, { status: 500 })
  }
}
