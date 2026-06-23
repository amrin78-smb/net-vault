import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { normalizeModel, resolveEol } from '@/lib/eolSeed'

// Ensure the enrichment provenance columns exist. Self-heals on existing
// installs that never re-ran schema.sql, mirroring health-snapshot. The date
// columns (support_end_date, os_eol_date) already exist in the base schema.
async function ensureColumns() {
  await query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS eol_source TEXT`)
  await query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS eol_confidence TEXT`)
  await query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS eol_enriched_at TIMESTAMPTZ`)
}

type DeviceRow = {
  id: number
  brand: string | null
  model: string | null
  support_end_date: string | null
  os_eol_date: string | null
  eol_source: string | null
}

/**
 * POST /api/system/enrich-eol
 * Internal job (Windows Task Scheduler). Protected by a shared secret:
 *   Authorization: Bearer $CRON_SECRET
 *
 * Drives EOL/EOS enrichment from the CURATED SEED in lib/eolSeed.ts — there is
 * no free model-keyed EOL API for this fleet, so this NEVER calls an external
 * service and NEVER invents dates. For each device whose raw model matches a
 * seed entry it writes the seed's dates + provenance, but ONLY into a target
 * date column that is currently NULL or was previously seed-written
 * (eol_source = 'seed'). Human/manual dates are never overwritten.
 *
 * Supports a dry run via ?dryRun=1 or JSON body { dryRun: true } — computes what
 * WOULD change without writing.
 *
 * Always returns 200 (even if most devices are unmatched); the response's
 * `unmatchedTop` is the curation worklist used to grow the seed.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get('authorization') || ''
  if (!secret || provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // dryRun from query string or JSON body (body is optional).
  let dryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  try {
    const body = await req.json()
    if (body && body.dryRun === true) dryRun = true
  } catch {
    // no/invalid body — fine
  }

  try {
    await ensureColumns()

    const devRes = await query(`
      SELECT d.id,
             b.name AS brand,
             d.model,
             d.support_end_date,
             d.os_eol_date,
             d.eol_source
      FROM devices d
      LEFT JOIN brands b ON b.id = d.brand_id
    `)
    const devices = devRes.rows as DeviceRow[]

    let matched = 0
    let written = 0
    let skipped = 0
    const unmatched = new Map<string, { count: number; samples: Set<string> }>()

    for (const dev of devices) {
      const seed = resolveEol(dev.brand, dev.model)

      if (!seed) {
        const key = normalizeModel(dev.brand, dev.model)
        const bucket = unmatched.get(key) ?? { count: 0, samples: new Set<string>() }
        bucket.count += 1
        if (bucket.samples.size < 5 && dev.model) bucket.samples.add(dev.model)
        unmatched.set(key, bucket)
        continue
      }

      matched += 1

      // Only the seed columns that actually carry a date are eligible to write.
      // For each, only write where the existing value is NULL or was previously
      // seed-written — never clobber a human/manual non-null value.
      const sets: string[] = []
      const params: unknown[] = []
      let p = 1
      let wouldWriteAny = false

      const seedWritten = dev.eol_source === 'seed'

      if (seed.support_end_date !== null) {
        if (dev.support_end_date === null || seedWritten) {
          sets.push(`support_end_date = $${p}`)
          params.push(seed.support_end_date); p++
          wouldWriteAny = true
        }
      }
      if (seed.os_eol_date !== null) {
        if (dev.os_eol_date === null || seedWritten) {
          sets.push(`os_eol_date = $${p}`)
          params.push(seed.os_eol_date); p++
          wouldWriteAny = true
        }
      }

      if (!wouldWriteAny) {
        // Matched a seed but every eligible date is already a protected
        // (non-seed) human value — leave the row untouched.
        skipped += 1
        continue
      }

      written += 1

      if (!dryRun) {
        sets.push(`eol_source = $${p}`); params.push('seed'); p++
        sets.push(`eol_confidence = $${p}`); params.push(seed.confidence); p++
        sets.push(`eol_enriched_at = NOW()`)
        params.push(dev.id)
        await query(
          `UPDATE devices SET ${sets.join(', ')} WHERE id = $${p}`,
          params,
        )
      }
    }

    const unmatchedTop = Array.from(unmatched.entries())
      .map(([normalizedKey, v]) => ({
        normalizedKey,
        count: v.count,
        sampleModels: Array.from(v.samples),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25)

    return NextResponse.json({
      dryRun,
      scanned: devices.length,
      matched,
      written,
      skipped,
      unmatchedTop,
    })
  } catch (err) {
    console.error('[system/enrich-eol POST]', err)
    return NextResponse.json({ ok: false, error: 'Enrichment failed' }, { status: 500 })
  }
}
