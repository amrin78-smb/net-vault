/**
 * Regenerate lib/eolSeed.ts (the bundled OFFLINE EOL floor) from the central
 * nocvault-eol seed (data/eol-seed.json). Run from the netvault dir:
 *   node scripts/gen-eol-seed.cjs
 *
 * The bundled seed is what a fresh / air-gapped install starts with BEFORE any
 * "Sync from EOL feed" — keeping it in step with the central feed means offline
 * installs begin at full coverage instead of a handful of families.
 *
 * Confidence is reverse-mapped to the legacy bundled scheme (high→exact,
 * medium→family, low→inferred); migrateLegacySeed maps it straight back. The
 * source URL is folded into `note` (when not already present) so the existing
 * extractUrl(note) path still populates source_url.
 */
const fs = require('fs')
const path = require('path')

const CENTRAL = path.resolve(__dirname, '..', '..', 'nocvault-eol', 'data', 'eol-seed.json')
const OUT = path.resolve(__dirname, '..', 'lib', 'eolSeed.ts')

const central = JSON.parse(fs.readFileSync(CENTRAL, 'utf8'))

const confMap = { high: 'exact', medium: 'family', low: 'inferred' }
const s = (v) => JSON.stringify(v == null ? null : v)

// Sort for a stable, reviewable diff: by vendor then key.
const sorted = [...central].sort((a, b) =>
  (a.vendor || '').localeCompare(b.vendor || '') || (a.key || '').localeCompare(b.key || '')
)

const lines = sorted.map((e) => {
  const note = e.note || ''
  const src = e.source || ''
  const fullNote = src && !note.includes(src) ? (note ? `${note} ${src}` : src) : note
  const conf = confMap[e.confidence] || 'family'
  const fields = [
    `key: ${s(e.key)}`,
    `vendor: ${s(e.vendor)}`,
    `matches: ${s(e.matches || [])}`,
    `support_end_date: ${s(e.support_end_date ?? null)}`,
    `os_eol_date: ${s(e.os_eol_date ?? null)}`,
    `confidence: ${s(conf)}`,
    `note: ${s(fullNote)}`,
  ]
  if (e.lifecycle === 'eol') fields.push(`lifecycle: "eol"`)
  return `  { ${fields.join(', ')} },`
})

const dated = central.filter((e) => e.support_end_date || e.os_eol_date).length
const lifecycle = central.filter((e) => e.lifecycle === 'eol').length

const header = `/**
 * Curated EOL/EOS seed for the fleet — the bundled OFFLINE baseline.
 *
 * GENERATED FILE. Do not hand-edit. Regenerate from the central nocvault-eol
 * seed with:  node scripts/gen-eol-seed.cjs
 *
 * This is the offline FLOOR: a fresh / air-gapped install matches devices against
 * these ${central.length} vendor-confirmed models with NO internet. Live updates come from the
 * "Sync from EOL feed" button (lib/eolFeed.ts), which pulls the same central feed
 * and upserts on top. Source of truth is nocvault-eol/data/eol-seed.json.
 *
 * ${central.length} models (${dated} dated, ${lifecycle} lifecycle="eol"). NEVER hand-add dates here — add
 * them to the central seed and regenerate, so the feed and the floor stay in step.
 */

export type EolConfidence = 'exact' | 'family' | 'inferred'

export type EolSeedEntry = {
  /** Human label (vendor + model), for dedupe/readability. */
  key: string
  /** Vendor name — drives normalizeForMatch on the consuming side. */
  vendor: string
  /** RAW model strings this entry applies to ([0] canonical, [1..] aliases). */
  matches: string[]
  /** Vendor last-date-of-support (hardware) — ISO date or null if unknown. */
  support_end_date: string | null
  /** OS / software end-of-life — ISO date or null if unknown. */
  os_eol_date: string | null
  confidence: EolConfidence
  /** Human note: what this is and the vendor source for the date. */
  note: string
  /** 'eol' when the vendor confirmed the model retired but published NO date. */
  lifecycle?: 'eol'
}

/**
 * Normalize a brand/model pair into a deterministic join key.
 *
 * - uppercases
 * - trims and collapses internal whitespace to single spaces
 * - strips a leading vendor prefix from the model (longest match first)
 *
 * Deterministic and simple by design — this is the curation join key, not a
 * fuzzy matcher.
 */
export function normalizeModel(brand: string | null | undefined, model: string | null | undefined): string {
  const m = (model ?? '').toUpperCase().trim().replace(/\\s+/g, ' ')

  // Longest prefixes first so 'HPE ARUBA NETWORKING ' wins over 'HPE '.
  const prefixes = [
    'HPE ARUBA NETWORKING ',
    'ARUBA ',
    'HPE ',
    'HP ',
    'CISCO ',
    'RUCKUS ',
  ]

  let cleaned = m
  for (const prefix of prefixes) {
    if (cleaned.startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length).trim()
      break
    }
  }

  return cleaned
}

/**
 * Vendor-confirmed seed entries ONLY. Do not add unconfirmed/guessed dates.
 */
export const EOL_SEED: EolSeedEntry[] = [
`

const footer = `]

/**
 * Resolve the seed entry for a device by matching its RAW model string
 * (case-insensitive) against any entry's \`matches\`. Returns null when no
 * curated entry applies.
 */
export function resolveEol(
  brand: string | null | undefined,
  model: string | null | undefined,
): EolSeedEntry | null {
  const raw = (model ?? '').trim().toLowerCase()
  if (!raw) return null
  for (const entry of EOL_SEED) {
    if (entry.matches.some((mm) => mm.trim().toLowerCase() === raw)) {
      return entry
    }
  }
  return null
}
`

fs.writeFileSync(OUT, header + lines.join('\n') + '\n' + footer, 'utf8')
console.log(`Wrote ${OUT}: ${central.length} entries (${dated} dated, ${lifecycle} lifecycle=eol)`)
