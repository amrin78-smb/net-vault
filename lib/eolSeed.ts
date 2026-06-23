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

  // ── Bulk vendor-confirmed batch (researched 2026-06 against official EoS/EoL
  //    notices; source URL in each note). Current Wi-Fi 6 gear was researched too
  //    but had NO published vendor EOL and is intentionally omitted (see below). ──

  // Aruba campus/outdoor APs (HPE Aruba EOS notices)
  {
    key: 'ARUBA AP-210', matches: ['Aruba 215', 'Aruba 214'],
    support_end_date: '2023-02-01', os_eol_date: null, confidence: 'exact',
    note: 'Aruba 210-series Campus APs — End-of-Support 2023-02-01 (HPE Aruba EOS notice, 210 Series). https://asp-documents.arubanetworks.com/portals/0/el/EOS_Notice_210_Series_Campus_APs.pdf',
  },
  {
    key: 'ARUBA AP-207', matches: ['Aruba 207'],
    support_end_date: '2025-02-01', os_eol_date: null, confidence: 'exact',
    note: 'Aruba 207-series Campus APs — End-of-Support 2025-02-01 (HPE Aruba EOS notice). https://asp-documents.arubanetworks.com/portals/0/el/EOS_207-Series-Campus-APs.pdf',
  },
  {
    key: 'ARUBA AP-275', matches: ['Aruba 275'],
    support_end_date: '2024-08-01', os_eol_date: null, confidence: 'exact',
    note: 'Aruba AP-270-series Outdoor APs — End-of-Support 2024-08-01 (HPE Aruba EOS notice). https://asp-documents.arubanetworks.com/portals/0/el/EOS_Notice-AP-270.pdf',
  },
  {
    key: 'ARUBA AP-300', matches: ['Aruba 304', 'Aruba 305'],
    support_end_date: '2026-12-31', os_eol_date: null, confidence: 'exact',
    note: 'Aruba 300-series Campus APs — End of Support Life 2026-12-31 (HPE Aruba EOS-AP-2101). https://asp-documents.arubanetworks.com/portals/0/el/EOS_Notice_300_Series_Campus_APs.pdf',
  },
  {
    key: 'ARUBA AP-365', matches: ['Aruba 365'],
    support_end_date: '2028-07-31', os_eol_date: null, confidence: 'exact',
    note: 'Aruba 360-series Outdoor APs — End of Support Life 2028-07-31 (HPE Aruba EOS notice). https://asp-documents.arubanetworks.com/portals/0/el/EOS_Notice_360-Series-Outdoor-Access-Points.pdf',
  },
  {
    key: 'ARUBA 6200F', matches: ['Aruba 6200F 24G Cl4 PoE 4SFP+ 370W'],
    support_end_date: '2032-07-31', os_eol_date: null, confidence: 'exact',
    note: 'Aruba 6200F switch (JL725A) — End of Support Life 2032-07-31 (HPE Aruba 6200F EoS notice, Sep 2023). https://asp-documents.arubanetworks.com/portals/0/External_EoS%20Announcement_Aruba_6200F_v0.4_September2023.pdf',
  },

  // HP legacy (HPE Networking EOS announcements)
  {
    key: 'HP MSM4XX', matches: ['E-MSM430', 'E-MSM460', 'MSM460', 'MSM 460', 'MSM466'],
    support_end_date: '2016-05-31', os_eol_date: null, confidence: 'family',
    note: 'HP MSM430/460/466 802.11n APs — End-of-Sale 2016-05-31 (HPE Mobility Products EoS Announcement, Feb 2016); end-of-life. https://support.hpe.com/docs/display/public/hpe-networking-eos/docs/products/eos/HPN%20Mobility%20Products%20-%20EoS%20Announcement%20-%20February%202016%20-%20External.pdf',
  },
  {
    key: 'HP 5120 EI', matches: ['HP 5120-24G EI', 'HP 5120-48G EI'],
    support_end_date: '2015-10-01', os_eol_date: null, confidence: 'exact',
    note: 'HP 5120 EI switch series — End-of-Sale 2015-10-01, replaced by 5130 EI (HPE EoS announcement); end-of-life. https://support.hpe.com/docs/display/public/hpe-networking-eos/docs/products/eos/HP%205120%20and%205500%20Switch%20Series%20EOS%20Announcement.pdf',
  },
  {
    key: 'HP 5130 EI', matches: ['HP 5130-48G-2SFP+-2XGT EI', 'HPE 5130-24G-4SFP+ EI'],
    support_end_date: '2022-04-30', os_eol_date: null, confidence: 'exact',
    note: 'HPE FlexNetwork 5130 EI switch series — End-of-Sale 2022-04-30 (HPE/Aruba EoS announcement, Nov 2021), replaced by 5140 EI. https://www.arubanetworks.com/assets/support/EOS_HPE-FlexNetwork-5510-HI-5130-EI-Switch-Series.pdf',
  },

  // Allied Telesis (official end-of-sale list)
  {
    key: 'AT-TQ5403E', matches: ['AT-TQ5403e'],
    support_end_date: '2021-06-09', os_eol_date: null, confidence: 'exact',
    note: 'Allied Telesis AT-TQ5403e — End of SW Support 2021-06-09 (End of Life 2024-06-09); Allied Telesis official EoS list. https://www.alliedtelesis.com/us/en/products/end-of-sale-list',
  },
  {
    key: 'AT-X510L-28GP', matches: ['Allied Telesis AT-x510L-28GP'],
    support_end_date: '2022-03-19', os_eol_date: null, confidence: 'exact',
    note: 'Allied Telesis AT-x510L-28GP — End of SW Support 2022-03-19 (End of Life 2025-03-19); Allied Telesis official. https://www.alliedtelesis.com/us/en/products/switches/x510-series/x510l-28gp',
  },

  // Netgear (official EOL product list)
  {
    key: 'NETGEAR MS510TXPP', matches: ['MS510TXPP'],
    support_end_date: '2026-02-28', os_eol_date: null, confidence: 'exact',
    note: 'Netgear MS510TXPP (MS510TXPP-100EUS) — End-of-Service 2026-02-28 (Netgear EOL product list, Dec 2025). https://downloads1.netgear.com/files/netgear/pdfs/NFB_EOL_Product_ListDec2025v3_20251211.pdf',
  },
  {
    key: 'NETGEAR GS752TS', matches: ['GS752TS'],
    support_end_date: '2015-07-26', os_eol_date: null, confidence: 'exact',
    note: 'Netgear GS752TS-100AJS — End-of-Service 2015-07-26 (Netgear EOL product list); end-of-life. https://downloads1.netgear.com/files/netgear/pdfs/NFB_EOL_Product_ListDec2025v3_20251211.pdf',
  },

  // TP-Link (official US EOL list)
  {
    key: 'TPLINK TL-SG108', matches: ['TP-LINK 8-P TL-GS108'],
    support_end_date: '2024-09-21', os_eol_date: null, confidence: 'exact',
    note: 'TP-Link TL-SG108 8-port gigabit switch (HW v6.6) — End-of-Service 2024-09-21 (TP-Link US business EOL list). https://static.tp-link.com/upload/manual/2025/202509/20250903/US%20EOL%20List%20Business.pdf',
  },

  // Cisco (official EoS/EoL bulletins)
  {
    key: 'CISCO SF500', matches: ['Cisco SF500 24p'],
    support_end_date: '2023-04-30', os_eol_date: null, confidence: 'exact',
    note: 'Cisco SF500-24/24P (500 Series Stackable) — Last Date of Support 2023-04-30 (Cisco EoL bulletin c51-739827); end-of-life. https://www.cisco.com/c/en/us/products/collateral/switches/small-business-500-series-stackable-managed-switches/eos-eol-notice-c51-739827.html',
  },
  {
    key: 'CISCO AIRONET 2802I', matches: ['Cisco Aironet 2802i'],
    support_end_date: '2027-04-30', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Aironet 2800 series (AIR-AP2802I) — Last Date of Support 2027-04-30 (Cisco EoL announcement, Nov 2022). https://www.cisco.com/c/en/us/products/collateral/wireless/aironet-2800-series-access-points/aironet-2800-series-access-points-eol.html',
  },
  {
    key: 'CISCO SG300-28', matches: ['SG300-28'],
    support_end_date: '2023-11-30', os_eol_date: null, confidence: 'exact',
    note: 'Cisco SG300-28 (300 Series Managed) — Last Date of Support 2023-11-30 (Cisco EoL bulletin c51-740542); end-of-life. https://www.cisco.com/c/en/us/products/collateral/switches/small-business-300-series-managed-switches/eos-eol-notice-c51-740542.html',
  },

  // Cisco Meraki (official EOL page)
  {
    key: 'MERAKI MR46', matches: ['Meraki MR46'],
    support_end_date: '2031-12-31', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Meraki MR46 — End-of-Support 2031-12-31 (Meraki official EOL page). https://documentation.meraki.com/Platform_Management/Product_Information/End-of-Life_Notices/Meraki_End-of-Life_(EOL)_Products_and_Dates',
  },
  {
    key: 'MERAKI MR33', matches: ['Meraki MR33'],
    support_end_date: '2026-07-21', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Meraki MR33 — End-of-Support 2026-07-21 (Meraki official EOL page). https://documentation.meraki.com/Platform_Management/Product_Information/End-of-Life_Notices/Meraki_End-of-Life_(EOL)_Products_and_Dates',
  },
  {
    key: 'MERAKI MR52', matches: ['Meraki MR52'],
    support_end_date: '2026-07-21', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Meraki MR52 — End-of-Support 2026-07-21 (Meraki official EOL page). https://documentation.meraki.com/Platform_Management/Product_Information/End-of-Life_Notices/Meraki_End-of-Life_(EOL)_Products_and_Dates',
  },

  // ── Researched but UNCONFIRMED (no official vendor EOL date) — intentionally
  //    NOT seeded (no guessing). These are current Wi-Fi 6 / current-gen products:
  //    Aruba 504/505/515/575/615, Aruba 2930F (24G/48G PoE variants), Aruba CX
  //    6000/6100, Grandstream GWN766x, Ruckus R650/T350SE/T350C, Huawei AirEngine
  //    6761/5761 + S5731, Cisco C9200L/C9300, Palo Alto PA-460, Forcepoint NGFW
  //    120/120W/330, HPE 5140 EI, Cisco Aironet 1242AG (obsolete but exact dates
  //    not machine-verifiable). Revisit when vendors publish notices.
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
