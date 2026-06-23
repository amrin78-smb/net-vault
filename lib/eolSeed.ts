/**
 * Curated EOL/EOS seed for the fleet.
 *
 * There is NO free model-keyed EOL API that covers this fleet's vendors/models,
 * so EOL/EOS dates are driven by a hand-curated, vendor-confirmed seed instead.
 * This file is intentionally MINIMAL: it contains only entries whose dates were
 * confirmed against a vendor EoL/EoS bulletin. It grows by curation — the
 * enrichment route reports an "unmatched worklist" of the most common normalized
 * model keys that have NO seed entry, and each of those is researched and added
 * here with a vendor source in `note`.
 *
 * NEVER invent or infer EOL dates here. Only add entries backed by a vendor notice.
 */

export type EolConfidence = 'exact' | 'family' | 'inferred'

export type EolSeedEntry = {
  /** Normalized join key (output of normalizeModel for this family). */
  key: string
  /** EXACT raw `model` strings this entry applies to (matched case-insensitively). */
  matches: string[]
  /** Vendor last-date-of-support (hardware) — ISO date or null if unknown. */
  support_end_date: string | null
  /** OS / software end-of-life — ISO date or null if unknown. */
  os_eol_date: string | null
  confidence: EolConfidence
  /** Human note: what this is and the vendor source for the date. */
  note: string
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
  const m = (model ?? '').toUpperCase().trim().replace(/\s+/g, ' ')

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
  {
    key: 'CISCO AIR-CAP2602E',
    matches: ['AIR-CAP2602E-E-K9'],
    support_end_date: '2022-09-30',
    os_eol_date: '2022-09-30',
    confidence: 'exact',
    note: 'Cisco Aironet 2600 series — Last Date of Support 2022-09-30 (Cisco EoL bulletin)',
  },
  {
    key: 'ARUBA AP-315',
    matches: ['Aruba 315'],
    support_end_date: '2026-12-30',
    os_eol_date: null,
    confidence: 'exact',
    note: 'Aruba 310-series AP — end-of-support 2026-12-30 (HPE Aruba EOS notice)',
  },
  // ── Unconfirmed worklist (high-volume models, NO vendor date found) ──
  // Researched against vendor sources 2026-06; NO confirmed EoS/EoSL date
  // published, so deliberately NOT added to EOL_SEED (no guessing). Revisit
  // when HPE Aruba / Grandstream publish an official notice.
  //
  // unconfirmed: 'Aruba 505' (500-series Wi-Fi 6 AP, ~355 units). HPE Aruba has
  //   NOT published an EOS/EOSL notice for the 500 series (only 300/310-series
  //   notices EOS-AP-2101/2102 exist; the 500-series notice URL 404s). Third
  //   parties show only ESTIMATES, not vendor dates. Siblings 'Aruba 504'/'AP504'
  //   are in the same boat. Source: https://www.it-server-room.com/en/hpe-aruba-networks-wireless-ap-eos-eol-schedule/
  //   ("Aruba does not pre-announce EOS dates"; values are estimates).
  // unconfirmed: 'GWN7660' (Grandstream Wi-Fi 6 AP, ~56 units). No EOL/EOS
  //   announcement; Grandstream still lists it as an active product with recent
  //   firmware. Source: https://www.grandstream.com/products/networking-solutions/indoor-wifi-access-points/product/gwn7660
  // unconfirmed: 'Aruba 515' (510-series Wi-Fi 6 AP, ~54 units). No vendor EOS
  //   notice; ServiceExpress lists EOL/EOSL as "Date Not Published".
  //   Source: https://serviceexpress.com/eol-eosl-database/products/aruba-ap-515-network-connectivity/
  // unconfirmed: 'Aruba 575' (570-series outdoor Wi-Fi 6 AP, ~54 units). No
  //   vendor EOS notice published; only third-party estimates exist.
  //   Source: https://www.it-server-room.com/en/hpe-aruba-networks-wireless-ap-eos-eol-schedule/
]

/**
 * Resolve the seed entry for a device by matching its RAW model string
 * (case-insensitive) against any entry's `matches`. Returns null when no
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
