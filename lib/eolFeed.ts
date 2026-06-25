/**
 * Phase 2 — pull the central NocVault EOL feed into the local eol_seed catalog.
 *
 * SAFETY: this writes ONLY to the `eol_seed` reference table. It NEVER touches the
 * `devices` table and never runs enrichment — device EOL dates are filled by the
 * existing (separate) enrichment step. Reverting a sync is `DELETE FROM eol_seed
 * WHERE added_by = 'feed'`.
 *
 * The feed body is verified (sha256 + Ed25519 detached signature) against the bundled
 * public key before a single row is written, so a tampered or corrupt feed is rejected.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { query } from '@/lib/db'
import { ensureEolSchema, normalizeForMatch } from '@/lib/eolEnrich'

// Ed25519 public key (spki DER, base64) for the central feed. The matching private
// key lives only in the nocvault-eol build env (FEED_SIGNING_KEY).
const FEED_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAI+nk9JoWunzPTASALa5PLWwcLe9NNWRrZ72tMY8ZU2k='
const DEFAULT_FEED_URL = 'https://nocvault-eol.netlify.app'

type FeedModel = {
  vendor: string
  matches: string[]
  end_of_sale: string | null
  support_end_date: string | null
  os_eol_date: string | null
  confidence: 'high' | 'medium' | 'low' | string
  source: string | null
  note: string | null
  lifecycle?: string | null
}
type Feed = {
  schema_version: number
  normalizer_version: number
  feed_version: string
  generated_at: string
  row_count: number
  models: FeedModel[]
}

export type FeedSyncResult = {
  feed_version: string
  row_count: number
  inserted: number
  updated: number
  skipped: number
  verified: true
}

// Re-derive model_normalized + aliases for every eol_seed row using the CURRENT
// normalizer, then collapse rows that now share a normalized key (the enhanced
// normalizer can merge previously-distinct spellings). Idempotent + self-healing.
// Touches ONLY eol_seed (+ repoints eol_discrepancies FK refs before deleting).
async function recomputeSeedKeys(): Promise<void> {
  const { rows } = await query(`SELECT id, vendor, model_raw, aliases FROM eol_seed`)
  for (const r of rows as Array<{ id: number; vendor: string; model_raw: string; aliases: string[] }>) {
    const norm = normalizeForMatch(r.vendor, r.model_raw)
    const aliasNorms = (r.aliases || [])
      .map((a) => normalizeForMatch(r.vendor, String(a)))
      .filter((a) => a && a !== norm)
    await query(`UPDATE eol_seed SET model_normalized = $2, aliases = $3 WHERE id = $1`, [r.id, norm, aliasNorms])
  }
  const dups = await query(
    `SELECT model_normalized, array_agg(id ORDER BY
         (eol_date IS NOT NULL OR eos_date IS NOT NULL) DESC,
         CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, id) AS ids
       FROM eol_seed WHERE model_normalized <> ''
      GROUP BY model_normalized HAVING count(*) > 1`
  )
  for (const d of dups.rows as Array<{ model_normalized: string; ids: number[] }>) {
    const keep = d.ids[0]
    const drop = d.ids.slice(1)
    const ar = await query(`SELECT aliases FROM eol_seed WHERE id = ANY($1)`, [d.ids])
    const merged = [...new Set((ar.rows as Array<{ aliases: string[] }>).flatMap((x) => x.aliases || []))].filter((a) => a && a !== d.model_normalized)
    await query(`UPDATE eol_seed SET aliases = $2 WHERE id = $1`, [keep, merged])
    await query(`UPDATE eol_discrepancies SET seed_entry_id = $1 WHERE seed_entry_id = ANY($2)`, [keep, drop]).catch(() => {})
    await query(`DELETE FROM eol_seed WHERE id = ANY($1)`, [drop])
  }
}

export async function syncFromFeed(): Promise<FeedSyncResult> {
  const base = (process.env.NOCVAULT_EOL_FEED_URL || DEFAULT_FEED_URL).replace(/\/+$/, '')
  const licenseKey = process.env.NOCVAULT_EOL_LICENSE_KEY || 'netvault'

  const res = await fetch(`${base}/api/v1/feed`, {
    headers: { 'x-license-key': licenseKey },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Feed fetch failed: HTTP ${res.status}`)

  const body = await res.text()
  const sig = res.headers.get('x-feed-signature')
  const shaHeader = res.headers.get('x-feed-sha256')
  if (!sig) throw new Error('Feed response missing X-Feed-Signature')

  const sha256 = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
  if (shaHeader && shaHeader !== sha256) throw new Error('Feed sha256 mismatch')

  const pub = createPublicKey({ key: Buffer.from(FEED_PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki' })
  const ok = cryptoVerify(null, Buffer.from(body, 'utf8'), pub, Buffer.from(sig, 'base64'))
  if (!ok) throw new Error('Feed signature verification failed')

  const feed = JSON.parse(body) as Feed
  if (!Array.isArray(feed.models)) throw new Error('Feed has no models')

  await ensureEolSchema()
  // self-heal: recompute stale keys (normalizer may have changed) before upserting
  await recomputeSeedKeys()

  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const m of feed.models) {
    const vendor = String(m.vendor ?? '').trim()
    const raw = String(m.matches?.[0] ?? '').trim()
    if (!vendor || !raw) { skipped++; continue }

    const normalized = normalizeForMatch(vendor, raw)
    if (!normalized) { skipped++; continue }

    const aliasNorms = (m.matches.slice(1) || [])
      .map((a) => normalizeForMatch(vendor, String(a)))
      .filter((a) => a && a !== normalized)
    const conf = ['high', 'medium', 'low'].includes(m.confidence as string) ? m.confidence : 'medium'
    const lifecycle = m.lifecycle === 'eol' ? 'eol' : null
    // eol_seed.eol_date = software/OS EOL; eol_seed.eos_date = hardware support-end.
    const eolDate = m.os_eol_date || null
    const eosDate = m.support_end_date || null

    const upd = await query(
      `UPDATE eol_seed
          SET eol_date = $2, eos_date = $3, confidence = $4, source_url = $5,
              aliases = $6, lifecycle = $7, updated_at = NOW()
        WHERE model_normalized = $1`,
      [normalized, eolDate, eosDate, conf, m.source || null, aliasNorms, lifecycle]
    )
    if ((upd.rowCount ?? 0) > 0) {
      updated++
    } else {
      await query(
        `INSERT INTO eol_seed
           (vendor, model_raw, model_normalized, aliases, eol_date, eos_date, source_url, confidence, lifecycle, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'feed')`,
        [vendor, raw, normalized, aliasNorms, eolDate, eosDate, m.source || null, conf, lifecycle]
      )
      inserted++
    }
  }

  return { feed_version: feed.feed_version, row_count: feed.row_count, inserted, updated, skipped, verified: true }
}
