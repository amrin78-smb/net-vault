/**
 * EOL Intelligence — shared table init, seed migration, and matching engine.
 *
 * This is the runtime backend for the "EOL Intelligence" admin feature. It owns:
 *   - the self-healing schema for the three EOL tables (eol_seed,
 *     eol_enrichment_jobs, eol_discrepancies),
 *   - a one-time idempotent migration of the legacy hardcoded EOL_SEED array
 *     (lib/eolSeed.ts) into the eol_seed table,
 *   - the flexible per-device matching engine that reads seed rows from the
 *     TABLE (no longer from the hardcoded array).
 *
 * pg_trgm is OPTIONAL: if `CREATE EXTENSION IF NOT EXISTS pg_trgm` fails (e.g.
 * the app DB role lacks superuser/CREATE EXTENSION), fuzzy tiers degrade away —
 * exact + alias matching still work, and `fuzzyAvailable` reports false.
 */

import { query } from '@/lib/db'
import { EOL_SEED } from '@/lib/eolSeed'

// ── Schema self-heal ───────────────────────────────────────────────

let initPromise: Promise<EolInitResult> | null = null

export type EolInitResult = {
  /** True once pg_trgm is confirmed installed (so similarity() is usable). */
  fuzzyAvailable: boolean
}

/**
 * Idempotent runtime init. Creates the three EOL tables + the device
 * provenance columns, attempts pg_trgm, then migrates the legacy seed array.
 * Memoized so concurrent callers share a single init.
 */
export function ensureEolSchema(): Promise<EolInitResult> {
  if (!initPromise) {
    initPromise = doEnsureEolSchema().catch((err) => {
      // Reset so a transient failure can be retried on the next call.
      initPromise = null
      throw err
    })
  }
  return initPromise
}

async function doEnsureEolSchema(): Promise<EolInitResult> {
  // Device provenance columns (mirrors the legacy enrich-eol route + schema.sql).
  await query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS eol_source TEXT`)
  await query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS eol_confidence TEXT`)
  await query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS eol_enriched_at TIMESTAMPTZ`)

  await query(`
    CREATE TABLE IF NOT EXISTS eol_seed (
      id               SERIAL PRIMARY KEY,
      vendor           TEXT NOT NULL,
      model_raw        TEXT NOT NULL,
      model_normalized TEXT NOT NULL,
      aliases          TEXT[] DEFAULT '{}',
      eol_date         DATE,
      eos_date         DATE,
      source_url       TEXT,
      confidence       TEXT DEFAULT 'high',
      added_by         TEXT DEFAULT 'system',
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_eol_seed_normalized ON eol_seed (model_normalized)`)

  await query(`
    CREATE TABLE IF NOT EXISTS eol_enrichment_jobs (
      id            SERIAL PRIMARY KEY,
      status        TEXT DEFAULT 'pending',
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ,
      scanned       INT DEFAULT 0,
      matched       INT DEFAULT 0,
      written       INT DEFAULT 0,
      discrepancies INT DEFAULT 0,
      unmatched_top JSONB,
      error         TEXT
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_eol_jobs_status ON eol_enrichment_jobs (status)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_eol_jobs_id_desc ON eol_enrichment_jobs (id DESC)`)

  await query(`
    CREATE TABLE IF NOT EXISTS eol_discrepancies (
      id              SERIAL PRIMARY KEY,
      device_id       UUID REFERENCES devices(id),
      device_name     TEXT,
      model           TEXT,
      manual_date     DATE,
      seed_date       DATE,
      difference_days INT,
      seed_entry_id   INT REFERENCES eol_seed(id),
      status          TEXT DEFAULT 'pending',
      resolved_by     TEXT,
      resolved_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_eol_discrepancies_status ON eol_discrepancies (status)`)

  await query(`
    CREATE TABLE IF NOT EXISTS eol_recommendations (
      id                 SERIAL PRIMARY KEY,
      device_id          UUID REFERENCES devices(id),
      device_name        TEXT,
      model              TEXT,
      current_status     TEXT,
      recommended_status TEXT,
      reason             TEXT,
      seed_eol_date      DATE,
      seed_eos_date      DATE,
      seed_entry_id      INT REFERENCES eol_seed(id),
      confidence         TEXT DEFAULT 'high',
      status             TEXT DEFAULT 'pending',
      reviewed_by        TEXT,
      reviewed_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_eol_recommendations_status ON eol_recommendations (status)`)

  // pg_trgm is optional. We do NOT issue CREATE EXTENSION here — a privileged
  // DDL does not belong on the request path (it's declared in schema.sql / the
  // installer). Runtime only does a read-only existence check; fuzzy tiers
  // degrade away (exact + alias still work) when the extension is absent.
  let fuzzyAvailable = false
  try {
    const ext = await query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)
    fuzzyAvailable = ext.rows.length > 0
  } catch {
    fuzzyAvailable = false
  }

  await migrateLegacySeed()

  return { fuzzyAvailable }
}

/**
 * Migrate the legacy hardcoded EOL_SEED entries into eol_seed.
 * Idempotent: upserts by model_normalized so re-runs never duplicate, and a
 * pre-populated table is left untouched aside from (re)asserting the seeds.
 */
async function migrateLegacySeed(): Promise<void> {
  for (const entry of EOL_SEED) {
    const rawModel = entry.matches[0] ?? entry.key
    const vendor = deriveVendor(entry.key, rawModel)
    const normalized = normalizeForMatch(vendor, rawModel)
    // Other matches[] become aliases (normalized for matching).
    const aliases = entry.matches
      .slice(1)
      .map((m) => normalizeForMatch(vendor, m))
      .filter((a) => a && a !== normalized)
    const sourceUrl = extractUrl(entry.note)
    const confidence = mapLegacyConfidence(entry.confidence)

    // Idempotent without a unique constraint: skip if a row with the same
    // normalized key already exists (upsert-by-model_normalized semantics).
    const existing = await query(
      `SELECT 1 FROM eol_seed WHERE model_normalized = $1 LIMIT 1`,
      [normalized]
    )
    if (existing.rows.length > 0) continue

    await query(
      `INSERT INTO eol_seed
         (vendor, model_raw, model_normalized, aliases, eol_date, eos_date, source_url, confidence, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'system')`,
      [vendor, rawModel, normalized, aliases, entry.os_eol_date, entry.support_end_date, sourceUrl, confidence]
    )
  }
}

/** Derive a vendor name from the legacy key/raw model. */
function deriveVendor(key: string, rawModel: string): string {
  const k = key.toUpperCase()
  if (k.startsWith('CISCO')) return 'Cisco'
  if (k.startsWith('ARUBA') || k.startsWith('HPE') || k.startsWith('HP')) return 'Aruba'
  if (k.startsWith('RUCKUS')) return 'Ruckus'
  if (k.startsWith('GRANDSTREAM') || /^GWN/i.test(rawModel)) return 'Grandstream'
  if (k.startsWith('MERAKI')) return 'Meraki'
  // Fall back to the first token of the key.
  return key.split(/\s+/)[0] || 'Unknown'
}

/** Map legacy confidence (exact|family|inferred) → new scheme (high|medium|low). */
function mapLegacyConfidence(c: string): string {
  if (c === 'exact') return 'high'
  if (c === 'family') return 'medium'
  return 'low'
}

/** Pull the first http(s) URL out of a free-text note, else null. */
function extractUrl(note: string | null | undefined): string | null {
  if (!note) return null
  const m = note.match(/https?:\/\/[^\s)]+/)
  return m ? m[0] : null
}

// ── Matching engine ────────────────────────────────────────────────

/**
 * Normalize a device/seed model into a flat matching key.
 *  - lowercase
 *  - strip a leading vendor prefix
 *  - remove all punctuation & whitespace
 *  - strip region/series suffixes (-us/-ww/-row/series)
 *
 * Distinct from lib/eolSeed.normalizeModel (the legacy uppercase join key);
 * this one is aggressive and built for fuzzy/alias matching.
 */
export function normalizeForMatch(
  vendor: string | null | undefined,
  model: string | null | undefined
): string {
  let s = (model ?? '').toLowerCase().trim()
  if (!s) return ''

  // Strip leading vendor words (also drops a redundant vendor baked into model).
  const vendorWords = ['hpe aruba networking', 'aruba', 'hpe', 'hp', 'cisco', 'grandstream', 'ruckus', 'meraki']
  const v = (vendor ?? '').toLowerCase().trim()
  if (v) vendorWords.unshift(v)
  let changed = true
  while (changed) {
    changed = false
    for (const w of vendorWords) {
      if (w && (s === w || s.startsWith(w + ' ') || s.startsWith(w + '-'))) {
        s = s.slice(w.length).trim().replace(/^[-\s]+/, '')
        changed = true
        break
      }
    }
  }

  // Strip trailing region/series suffixes (repeat to catch chains like -e-k9? no:
  // those are model-defining, leave them — only strip the documented suffixes).
  let suffixChanged = true
  while (suffixChanged) {
    suffixChanged = false
    const next = s.replace(/(?:[-_\s]?(?:us|ww|row|series))$/i, '')
    if (next !== s) {
      s = next.trim()
      suffixChanged = true
    }
  }

  // Remove all remaining punctuation/whitespace.
  s = s.replace(/[^a-z0-9]/g, '')
  return s
}

export type SeedRow = {
  id: number
  vendor: string
  model_raw: string
  model_normalized: string
  aliases: string[]
  eol_date: string | null
  eos_date: string | null
  source_url: string | null
  confidence: string
}

export type MatchResult = {
  seed: SeedRow
  /** How the match was made. */
  via: 'exact' | 'alias' | 'fuzzy'
  /** Effective confidence to record: seed.confidence for exact/alias, 'medium' for fuzzy. */
  confidence: string
  /** trigram similarity score for fuzzy matches (0..1), else 1. */
  score: number
} | {
  seed: null
  /** A near-miss (0.5–0.7) surfaced for the worklist — NOT written. */
  possible?: { model_raw: string; score: number }
}

/** Load all seed rows from the table. */
export async function loadSeedRows(): Promise<SeedRow[]> {
  // Cast DATE columns to text so the pg driver returns 'YYYY-MM-DD' strings, not
  // local-midnight Date objects (which roll back a day under +07 → off-by-one).
  const res = await query(
    `SELECT id, vendor, model_raw, model_normalized, aliases,
            eol_date::text AS eol_date, eos_date::text AS eos_date, source_url, confidence
     FROM eol_seed`
  )
  return res.rows.map((r: any) => ({
    id: r.id,
    vendor: r.vendor,
    model_raw: r.model_raw,
    model_normalized: r.model_normalized,
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
    eol_date: r.eol_date ? toIso(r.eol_date) : null,
    eos_date: r.eos_date ? toIso(r.eos_date) : null,
    source_url: r.source_url,
    confidence: r.confidence || 'high',
  }))
}

function toIso(d: any): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return String(d).slice(0, 10)
}

/**
 * Match a single device model against the loaded seed rows.
 *
 * Tiers:
 *   b. exact vs model_normalized → write (seed confidence)
 *   c. match vs any alias        → write (seed confidence)
 *   d. fuzzy similarity > 0.7    → write (medium)        [fuzzy only]
 *   e. fuzzy 0.5–0.7             → DO NOT write; surface as possible match
 *
 * `fuzzyAvailable=false` skips tiers (d)/(e) entirely (exact+alias only).
 */
export function matchDevice(
  deviceNormalized: string,
  seeds: SeedRow[],
  fuzzyAvailable: boolean
): MatchResult {
  if (!deviceNormalized) return { seed: null }

  // b. exact
  for (const s of seeds) {
    if (s.model_normalized && s.model_normalized === deviceNormalized) {
      return { seed: s, via: 'exact', confidence: s.confidence, score: 1 }
    }
  }
  // c. alias
  for (const s of seeds) {
    if (s.aliases.some((a) => a && a === deviceNormalized)) {
      return { seed: s, via: 'alias', confidence: s.confidence, score: 1 }
    }
  }

  if (!fuzzyAvailable) return { seed: null }

  // d/e. fuzzy — find best trigram similarity across normalized + aliases.
  let best: { seed: SeedRow; score: number } | null = null
  for (const s of seeds) {
    const candidates = [s.model_normalized, ...s.aliases].filter(Boolean)
    for (const cand of candidates) {
      const score = trigramSimilarity(cand, deviceNormalized)
      if (!best || score > best.score) best = { seed: s, score }
    }
  }
  if (best && best.score > 0.7) {
    return { seed: best.seed, via: 'fuzzy', confidence: 'medium', score: best.score }
  }
  if (best && best.score >= 0.5) {
    return { seed: null, possible: { model_raw: best.seed.model_raw, score: round2(best.score) } }
  }
  return { seed: null }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Pure-JS trigram similarity, mirroring pg_trgm's similarity() closely enough
 * for tier selection. (We avoid a per-device SQL round-trip; the extension is
 * still required to be present — its absence means the data is *probably* a
 * permission-limited box where we shouldn't fuzzy-match at all.)
 *
 * pg_trgm pads each string with two leading spaces and one trailing space, then
 * takes Jaccard similarity over the trigram sets.
 */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a)
  const tb = trigrams(b)
  if (ta.size === 0 && tb.size === 0) return a === b ? 1 : 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

function trigrams(s: string): Set<string> {
  const set = new Set<string>()
  if (!s) return set
  // pg_trgm: split on non-alphanumerics into words, pad each "  word ".
  const words = s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const w of words) {
    const padded = '  ' + w + ' '
    for (let i = 0; i < padded.length - 2; i++) {
      set.add(padded.slice(i, i + 3))
    }
  }
  return set
}

// ── Device load + match-preview (shared by routes) ─────────────────

export type DeviceRow = {
  id: string
  name: string | null
  brand: string | null
  model: string | null
  lifecycle_status: string | null
  support_end_date: string | null
  os_eol_date: string | null
  eol_source: string | null
}

export async function loadDevices(): Promise<DeviceRow[]> {
  const res = await query(`
    SELECT d.id,
           d.name,
           b.name AS brand,
           d.model,
           d.lifecycle_status,
           d.support_end_date::text AS support_end_date,
           d.os_eol_date::text AS os_eol_date,
           d.eol_source
    FROM devices d
    LEFT JOIN brands b ON b.id = d.brand_id
  `)
  return res.rows.map((r: any) => ({
    id: String(r.id),
    name: r.name,
    brand: r.brand,
    model: r.model,
    lifecycle_status: r.lifecycle_status,
    support_end_date: r.support_end_date ? toIso(r.support_end_date) : null,
    os_eol_date: r.os_eol_date ? toIso(r.os_eol_date) : null,
    eol_source: r.eol_source,
  }))
}

/**
 * Preview how many devices a (vendor, model) seed candidate would match —
 * read-only, no writes. Used by the add-entry & preview routes.
 */
export async function previewMatch(
  vendor: string | null,
  modelRaw: string,
  opts?: { aliases?: string[] }
): Promise<{ normalized: string; count: number; sample: Array<{ id: string; name: string | null; model: string | null }> }> {
  const init = await ensureEolSchema()
  const normalized = normalizeForMatch(vendor, modelRaw)
  const aliasNorms = (opts?.aliases ?? []).map((a) => normalizeForMatch(vendor, a)).filter(Boolean)
  const pseudoSeed: SeedRow = {
    id: -1,
    vendor: vendor || '',
    model_raw: modelRaw,
    model_normalized: normalized,
    aliases: aliasNorms,
    eol_date: null,
    eos_date: null,
    source_url: null,
    confidence: 'high',
  }
  const devices = await loadDevices()
  const sample: Array<{ id: string; name: string | null; model: string | null }> = []
  let count = 0
  for (const d of devices) {
    const dn = normalizeForMatch(d.brand, d.model)
    const m = matchDevice(dn, [pseudoSeed], init.fuzzyAvailable)
    if (m.seed) {
      count++
      if (sample.length < 10) sample.push({ id: d.id, name: d.name, model: d.model })
    }
  }
  return { normalized, count, sample }
}

/** Days between two ISO dates (b - a). */
export function diffDays(aIso: string | null, bIso: string | null): number {
  if (!aIso || !bIso) return 0
  const a = new Date(aIso + 'T00:00:00Z').getTime()
  const b = new Date(bIso + 'T00:00:00Z').getTime()
  return Math.round((b - a) / 86400000)
}

const EOL_LIFECYCLE = 'EOL / EOS'

/** Lifecycle values that count as "active / supported" (the real value has a comma). */
const ACTIVE_LIFECYCLE = new Set(['Active, Supported', 'Active', 'Supported', 'Active/Supported'])

/**
 * Run the full enrichment pass for a job that has already been INSERTed with
 * status='running'. Designed to run in the background (setImmediate); it owns
 * updating the job row's progress + terminal state and NEVER throws to the
 * caller (errors are persisted onto the job).
 *
 * Write rule (per device that matches a seed):
 *  - DISCREPANCY: if lifecycle_status = 'EOL / EOS' (manual) AND
 *    (support_end_date IS NULL OR support_end_date <> seed.eos_date) →
 *    record an eol_discrepancies row and DO NOT overwrite the manual date.
 *  - Otherwise apply the date only where support_end_date IS NULL or
 *    eol_source='seed' (never clobber a manual non-seed date), plus os_eol_date
 *    under the same NULL-or-seed rule, and stamp provenance.
 */
export async function runEnrichment(jobId: number, fuzzyAvailable: boolean): Promise<void> {
  try {
    const seeds = await loadSeedRows()
    const devices = await loadDevices()

    // tz-safe "today" as an ISO 'YYYY-MM-DD' string (matches seed date strings).
    const today = (await query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d as string

    let matched = 0
    let written = 0
    let discrepancies = 0
    let recommendations = 0
    const unmatched = new Map<string, { count: number; samples: Set<string>; note?: string }>()

    let processed = 0
    for (const dev of devices) {
      processed++
      const dn = normalizeForMatch(dev.brand, dev.model)
      const result = matchDevice(dn, seeds, fuzzyAvailable)

      if (!result.seed) {
        const key = dn || '(empty)'
        const bucket = unmatched.get(key) ?? { count: 0, samples: new Set<string>() }
        bucket.count += 1
        if (bucket.samples.size < 5 && dev.model) bucket.samples.add(dev.model)
        if (result.possible) {
          bucket.note = `possible match: ${result.possible.model_raw} (${result.possible.score})`
        }
        unmatched.set(key, bucket)
        continue
      }

      matched += 1
      const seed = result.seed

      // ── Discrepancy path: manual EOL/EOS device whose manual date disagrees.
      // Only a genuinely MANUAL date can be a discrepancy — never flag a date this
      // enrichment itself seed-wrote (eol_source='seed').
      const isManualEol = dev.lifecycle_status === EOL_LIFECYCLE && dev.eol_source !== 'seed'
      const dateDisagrees =
        seed.eos_date !== null &&
        (dev.support_end_date === null || dev.support_end_date !== seed.eos_date)

      if (isManualEol && dateDisagrees) {
        // Avoid duplicate rows for the same device+seed_entry, and never
        // re-flag a discrepancy the admin chose to ignore.
        const dup = await query(
          `SELECT 1 FROM eol_discrepancies
           WHERE device_id = $1 AND seed_entry_id = $2
             AND status IN ('pending', 'ignored', 'resolved') LIMIT 1`,
          [dev.id, seed.id]
        )
        if (dup.rows.length === 0) {
          await query(
            `INSERT INTO eol_discrepancies
               (device_id, device_name, model, manual_date, seed_date, difference_days, seed_entry_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
            [
              dev.id,
              dev.name,
              dev.model,
              dev.support_end_date,
              seed.eos_date,
              diffDays(dev.support_end_date, seed.eos_date),
              seed.id,
            ]
          )
          discrepancies += 1
        }
        // Do NOT overwrite the manual date when a discrepancy is recorded.
        continue
      }

      // This matched device is NOT a (new) discrepancy — clear any stale pending
      // discrepancy left from a prior false flag or a now-agreeing date.
      await query(
        `DELETE FROM eol_discrepancies WHERE device_id = $1 AND seed_entry_id = $2 AND status = 'pending'`,
        [dev.id, seed.id]
      )

      // ── Normal write path: only where the date is unset or seed-written.
      const sets: string[] = []
      const params: unknown[] = []
      let p = 1
      let wouldWriteAny = false
      const seedWritten = dev.eol_source === 'seed'

      if (seed.eos_date !== null && (dev.support_end_date === null || seedWritten)) {
        sets.push(`support_end_date = $${p}`); params.push(seed.eos_date); p++
        wouldWriteAny = true
      }
      if (seed.eol_date !== null && (dev.os_eol_date === null || seedWritten)) {
        sets.push(`os_eol_date = $${p}`); params.push(seed.eol_date); p++
        wouldWriteAny = true
      }

      if (wouldWriteAny) {
        sets.push(`eol_source = $${p}`); params.push('seed'); p++
        sets.push(`eol_confidence = $${p}`); params.push(result.confidence); p++
        sets.push(`eol_enriched_at = NOW()`)
        params.push(dev.id)
        await query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $${p}`, params)
        written += 1
      }

      // ── Status recommendations ──────────────────────────────────────
      // Only for high-confidence exact/alias matches — NEVER fuzzy/medium.
      if ((result.via === 'exact' || result.via === 'alias') && seed.confidence === 'high') {
        const effectiveEol = seed.eol_date ?? seed.eos_date
        if (effectiveEol) {
          const delta = diffDays(today, effectiveEol) // effectiveEol - today
          let recommended: string | null = null
          let reason = ''

          if (ACTIVE_LIFECYCLE.has(dev.lifecycle_status ?? '') && delta < 0) {
            // CASE 1 — should be EOL: active device whose vendor EOL date has passed.
            recommended = EOL_LIFECYCLE
            reason = `Vendor confirmed EOL date ${effectiveEol} has passed`
          } else if (dev.lifecycle_status === EOL_LIFECYCLE && delta > 90) {
            // CASE 2 — possibly incorrect EOL: vendor still supports for > 90 days.
            recommended = 'Active, Supported'
            reason = `Vendor confirms support until ${effectiveEol} — ${delta} days remaining`
          }

          if (recommended) {
            // Dedupe / cooldown: skip if a pending row exists, or an ignored row
            // was reviewed within the last 90 days (don't reappear for 90 days).
            const existing = await query(
              `SELECT 1 FROM eol_recommendations
               WHERE device_id = $1
                 AND (status = 'pending'
                      OR (status = 'ignored' AND reviewed_at > NOW() - INTERVAL '90 days'))
               LIMIT 1`,
              [dev.id]
            )
            if (existing.rows.length === 0) {
              await query(
                `INSERT INTO eol_recommendations
                   (device_id, device_name, model, current_status, recommended_status,
                    reason, seed_eol_date, seed_eos_date, seed_entry_id, confidence, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'high', 'pending')`,
                [
                  dev.id,
                  dev.name,
                  dev.model,
                  dev.lifecycle_status,
                  recommended,
                  reason,
                  seed.eol_date,
                  seed.eos_date,
                  seed.id,
                ]
              )
              recommendations += 1
            }
          } else {
            // AUTO-CLEAR: neither case applies (e.g. the status was already
            // corrected) — drop any stale pending recommendation for this device.
            await query(
              `DELETE FROM eol_recommendations WHERE device_id = $1 AND status = 'pending'`,
              [dev.id]
            )
          }
        }
      }

      // Periodically flush progress so the status route shows movement.
      if (processed % 50 === 0) {
        await query(
          `UPDATE eol_enrichment_jobs
             SET scanned = $1, matched = $2, written = $3, discrepancies = $4
           WHERE id = $5`,
          [processed, matched, written, discrepancies, jobId]
        )
      }
    }

    const unmatchedTop = Array.from(unmatched.entries())
      .map(([normalizedKey, v]) => ({
        normalizedKey,
        model: Array.from(v.samples)[0] ?? normalizedKey,
        count: v.count,
        sampleModels: Array.from(v.samples),
        ...(v.note ? { note: v.note } : {}),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25)

    await query(
      `UPDATE eol_enrichment_jobs
         SET status = 'completed', completed_at = NOW(),
             scanned = $1, matched = $2, written = $3, discrepancies = $4,
             unmatched_top = $5
       WHERE id = $6`,
      [devices.length, matched, written, discrepancies, JSON.stringify(unmatchedTop), jobId]
    )
    console.log(
      `[eolEnrich] job ${jobId} done: scanned=${devices.length} matched=${matched} ` +
      `written=${written} discrepancies=${discrepancies} recommendations=${recommendations}`
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await query(
        `UPDATE eol_enrichment_jobs SET status = 'failed', completed_at = NOW(), error = $1 WHERE id = $2`,
        [message, jobId]
      )
    } catch (e2) {
      console.error('[eolEnrich] failed to record job failure', e2)
    }
    console.error('[eolEnrich runEnrichment]', err)
  }
}
