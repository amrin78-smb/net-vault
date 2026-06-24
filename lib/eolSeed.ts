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
  {
    key: 'HP A5120 EI', matches: ['HP A5120-48G EI', 'HP A5120-24G EI', 'HP A5120-24G-PoE+ EI'],
    support_end_date: '2015-10-01', os_eol_date: null, confidence: 'exact',
    note: 'HP A5120 EI switches — same hardware as HP 5120 EI (older A-series/H3C branding; HPE docs use both names). End-of-Sale 2015-10-01 (HPE 5120/5500 Switch Series EoS announcement); end-of-life. https://support.hpe.com/docs/display/public/hpe-networking-eos/docs/products/eos/HP%205120%20and%205500%20Switch%20Series%20EOS%20Announcement.pdf',
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
    key: 'CISCO SG300-28', matches: ['SG300-28', 'SG300-28PP'],
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

  // ── Second sweep (researched 2026-06) — newly-added fleet models, vendor-confirmed ──
  {
    key: 'CISCO C2960X', matches: ['Cisco Catalyst 2960-X 48 GigE, 4 x 1G SFP'],
    support_end_date: '2027-10-31', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Catalyst 2960-X series — Last Date of Support 2027-10-31 (Cisco EoL bulletin c51-744432; EoS 2022-10-31). https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-2960-x-series-switches/eos-eol-notice-c51-744432.html',
  },
  {
    key: 'CISCO C2960', matches: ['WS-C2960-24PC-L'],
    support_end_date: '2019-10-31', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Catalyst 2960 (classic) — Last Date of Support 2019-10-31 (Cisco EoL bulletin c51-730121); end-of-life. https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-2960-series-switches/eos-eol-notice-c51-730121.html',
  },
  {
    key: 'CISCO AIRONET 3802I', matches: ['AIR-AP3802I-E-K9'],
    support_end_date: '2027-10-31', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Aironet 3800 series (AIR-AP3802I) — Last Date of Support 2027-10-31 (Cisco EoL bulletin; EoS 2022-10-31). https://www.cisco.com/c/en/us/products/collateral/wireless/aironet-3800-series-access-points/aironet-3800-series-access-points-eol.html',
  },
  {
    key: 'CISCO CBS350', matches: ['CBS350-48T-4G', 'CBS350-24T-4G', 'Cisco CBS350 Managed 24-port GE, 4x1G SFP'],
    support_end_date: '2029-10-31', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Business CBS350 series (select models) — Last Date of Support 2029-10-31 (Cisco EoL bulletin; EoS 2024-10-29). https://www.cisco.com/c/en/us/products/collateral/switches/business-350-series-managed-switches/business-cbs350-series-managed-switch-mod-eol.html',
  },
  {
    key: 'MERAKI MR20', matches: ['Meraki MR20'],
    support_end_date: '2028-06-13', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Meraki MR20 — End-of-Support 2028-06-13 (Meraki official EOL page). https://documentation.meraki.com/Platform_Management/Product_Information/End-of-Life_Notices/Meraki_End-of-Life_(EOL)_Products_and_Dates',
  },
  {
    key: 'MERAKI MS120-24', matches: ['Meraki MS120-24', 'Cisco Meraki MS120-24'],
    support_end_date: '2030-03-28', os_eol_date: null, confidence: 'exact',
    note: 'Cisco Meraki MS120 family (incl. MS120-24) — End-of-Support 2030-03-28 (Meraki official EOL page). https://documentation.meraki.com/Platform_Management/Product_Information/End-of-Life_Notices/Meraki_End-of-Life_(EOL)_Products_and_Dates',
  },
  {
    key: 'ARUBA 7205', matches: ['Aruba 7205 Controller'],
    support_end_date: '2024-11-30', os_eol_date: null, confidence: 'exact',
    note: 'Aruba 7205 Mobility Controller — End-of-Sale 2024-11-30 ("EOS Planning"; HPE Aruba warranty/EOS quick reference, Oct 2024). https://asp-documents.arubanetworks.com/portals/0/el/warranty-coverage-quick-reference.pdf',
  },
  {
    key: 'TPLINK TL-SG1016', matches: ['TP-LINK 16-P TL-SG1016'],
    support_end_date: '2024-12-03', os_eol_date: null, confidence: 'exact',
    note: 'TP-Link TL-SG1016 16-port switch — latest HW version End-of-Sale 2024-12-03 (TP-Link US Business EOL list). https://static.tp-link.com/upload/manual/2025/202509/20250903/US%20EOL%20List%20Business.pdf',
  },
  {
    key: 'TPLINK TL-SG1024', matches: ['TP-LINK 24-P TL-SG1024'],
    support_end_date: '2024-09-21', os_eol_date: null, confidence: 'exact',
    note: 'TP-Link TL-SG1024 24-port switch — latest HW version End-of-Sale 2024-09-21 (TP-Link US Business EOL list). https://static.tp-link.com/upload/manual/2025/202509/20250903/US%20EOL%20List%20Business.pdf',
  },

  // ── Third sweep (researched 2026-06) — legacy tail, vendor-confirmed ──
  // Cisco switches / routers (Cisco EoL bulletins; LDoS → support_end_date)
  { key: 'CISCO C2960X-24PS', matches: ['WS-C2960X-24PS-L'], support_end_date: '2027-10-31', os_eol_date: null, confidence: 'exact', note: 'Cisco Catalyst 2960-X — LDoS 2027-10-31 (Cisco EoL c51-744432). https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-2960-x-series-switches/eos-eol-notice-c51-744432.html' },
  { key: 'CISCO C2960C', matches: ['WS-C2960C-8PC-L'], support_end_date: '2025-10-31', os_eol_date: null, confidence: 'exact', note: 'Cisco Catalyst 2960-C — LDoS 2025-10-31 (Cisco EoL c51-743071). https://www.cisco.com/c/en/us/products/switches/catalyst-2960-c-series-switches/eos-eol-notice-c51-743071.html' },
  { key: 'CISCO C3750X', matches: ['WS-C3750X'], support_end_date: '2028-09-30', os_eol_date: null, confidence: 'exact', note: 'Cisco Catalyst 3750-X — LDoS 2028-09-30 (Cisco EoL, 2023). https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-3750-x-series-switches/catalyst-3750-x-series-switches-eol.html' },
  { key: 'CISCO ISR1941', matches: ['Cisco Router 1941', 'CISCO C1941'], support_end_date: '2023-09-30', os_eol_date: null, confidence: 'exact', note: 'Cisco ISR 1941 router — LDoS 2023-09-30 (Cisco EoL c51-740520); end-of-life. https://www.cisco.com/c/en/us/products/collateral/routers/1900-series-integrated-services-routers-isr/eos-eol-notice-c51-740520.html' },
  { key: 'CISCO C2960-24P', matches: ['Cisco Catalyst 2960 24p'], support_end_date: '2019-10-31', os_eol_date: null, confidence: 'exact', note: 'Cisco Catalyst 2960 (classic) 24-port — LDoS 2019-10-31 (Cisco EoL c51-730121); end-of-life. https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-2960-series-switches/eos-eol-notice-c51-730121.html' },
  { key: 'CISCO SG350-28', matches: ['SG350-28', 'SG350-52'], support_end_date: '2026-10-31', os_eol_date: null, confidence: 'exact', note: 'Cisco SG350-28 (350 Series) — LDoS 2026-10-31 (Cisco EoL c51-2442364). https://www.cisco.com/c/en/us/products/collateral/switches/350-series-managed-switches/eos-eol-notice-c51-2442364.html' },
  { key: 'CISCO SF302-08PP', matches: ['SF302-08PP 8-P'], support_end_date: '2023-10-31', os_eol_date: null, confidence: 'exact', note: 'Cisco SF302-08PP (300 Series) — LDoS 2023-10-31 (Cisco EoL c51-740542); end-of-life. https://www.cisco.com/c/en/us/products/collateral/switches/small-business-300-series-managed-switches/eos-eol-notice-c51-740542.html' },
  { key: 'CISCO C1000-8FP', matches: ['C1000-8FP-2G-L'], support_end_date: '2030-04-30', os_eol_date: null, confidence: 'exact', note: 'Cisco Catalyst 1000 (C1000-8FP-2G-L) — LDoS 2030-04-30 (Cisco EoL, 2024; EoS 2025-04-30). https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-1000-series-switches/catalyst-1000-series-switches-eol.html' },
  // Cisco Aironet APs (Cisco EoL bulletins)
  { key: 'CISCO AIRONET 3602I', matches: ['AIR-CAP3602I-E-K9'], support_end_date: '2021-12-31', os_eol_date: null, confidence: 'exact', note: 'Cisco Aironet 3600 (AIR-CAP3602I) — LDoS 2021-12-31 (Cisco EoL c51-737511); end-of-life. https://www.cisco.com/c/en/us/products/collateral/wireless/aironet-3600-series/eos-eol-notice-c51-737511.html' },
  { key: 'CISCO AIRONET 1702I', matches: ['AIR-CAP1702I-E-K9'], support_end_date: '2024-04-30', os_eol_date: null, confidence: 'exact', note: 'Cisco Aironet 1700 (AIR-CAP1702I) — LDoS 2024-04-30 (Cisco EoL c51-740712). https://www.cisco.com/c/en/us/products/collateral/wireless/eos-eol-notice-c51-740712.html' },
  { key: 'CISCO AIRONET 2702I', matches: ['Cisco Aironet 2702I'], support_end_date: '2024-04-30', os_eol_date: null, confidence: 'exact', note: 'Cisco Aironet 2700 (AIR-CAP2702I) — LDoS 2024-04-30 (Cisco EoL c51-740711). https://www.cisco.com/c/en/us/products/collateral/wireless/aironet-2700-series-access-point/eos-eol-notice-c51-740711.html' },
  { key: 'CISCO AIRONET 1815I', matches: ['Cisco Aironet 1815i'], support_end_date: '2027-04-30', os_eol_date: null, confidence: 'exact', note: 'Cisco Aironet 1815 (AIR-AP1815I) — LDoS 2027-04-30 (Cisco EoL). https://www.cisco.com/c/en/us/products/collateral/wireless/aironet-1815-series-access-points/aironet-1815-series-access-points-eol.html' },
  // Cisco Meraki (official EOL page)
  { key: 'MERAKI MS210-24', matches: ['Meraki MS210-24'], support_end_date: '2031-04-30', os_eol_date: null, confidence: 'exact', note: 'Cisco Meraki MS210 — End-of-Support 2031-04-30 (Meraki EOL page). https://documentation.meraki.com/Platform_Management/Product_Information/End-of-Life_Notices/Meraki_End-of-Life_(EOL)_Products_and_Dates' },
  { key: 'MERAKI MS120-8FP', matches: ['Meraki MS120-8FP'], support_end_date: '2030-03-28', os_eol_date: null, confidence: 'exact', note: 'Cisco Meraki MS120-8FP — End-of-Support 2030-03-28 (Meraki EOL page). https://documentation.meraki.com/Platform_Management/Product_Information/End-of-Life_Notices/Meraki_End-of-Life_(EOL)_Products_and_Dates' },
  { key: 'MERAKI MS355-24X', matches: ['Meraki MS355-24X'], support_end_date: '2030-08-08', os_eol_date: null, confidence: 'exact', note: 'Cisco Meraki MS355-24X — End-of-Support 2030-08-08 (Meraki EOL page). https://documentation.meraki.com/Platform_Management/Product_Information/End-of-Life_Notices/Meraki_End-of-Life_(EOL)_Products_and_Dates' },
  // HP / HPE legacy switches (HPE/Aruba EoS notices; eos = End-of-Sale)
  { key: 'HP 5130 HI', matches: ['HPE 5130 24G 4SFP+ 1-slot HI'], support_end_date: '2022-06-30', os_eol_date: null, confidence: 'exact', note: 'HPE 5130 HI (JH323A) — End-of-Sale 2022-06-30 (HPE/Aruba EoS, 2022). https://asp-documents.arubanetworks.com/portals/0/el/EOS_HPE-FlexNetwork-5130-HI-Switch-Series.pdf' },
  { key: 'HP 5130 EI POE', matches: ['HP 5130-24G-PoE+-4SFP+_370W  EI', 'HP 5130-48G-PoE+-4SFP+_370W  EI'], support_end_date: '2022-04-30', os_eol_date: null, confidence: 'exact', note: 'HPE 5130 EI PoE+ (JG936A/JG937A) — End-of-Sale 2022-04-30 (HPE/Aruba EoS, 2021). https://asp-documents.arubanetworks.com/portals/0/el/EOS_HPE-FlexNetwork-5510-HI-5130-EI-Switch-Series.pdf' },
  { key: 'HP 1950', matches: ['HP 1950-24G-2SFP+-2XGT-PoE+'], support_end_date: '2020-02-29', os_eol_date: null, confidence: 'exact', note: 'HPE OfficeConnect 1950 — End-of-Sale 2020-02-29 (HPE Aruba Hardware EoS list). https://asp-documents.arubanetworks.com/portals/0/el/Aruba-Hardware-End-of-Sale-List.pdf' },
  { key: 'HP A5120 SI', matches: ['HP A5120-16G SI', 'HP A5120-24G-PoE+ SI'], support_end_date: '2018-10-31', os_eol_date: null, confidence: 'exact', note: 'HPE 5120 SI (= A5120 SI, JE073B/JG091B) — End-of-Sale 2018-10-31 (HPE 5120 SI EoS, Mar 2018); end-of-life. https://support.hpe.com/docs/display/public/hpe-networking-eos/docs/products/eos/HPE%20FlexNetwork%205120%20SI%20Switch%20Series%20-%20External%20-%20March%202018.pdf' },
  { key: 'HP 2920', matches: ['HP 2920-24G Switch'], support_end_date: '2018-03-31', os_eol_date: null, confidence: 'exact', note: 'Aruba/HP 2920 (J9726A) — End-of-Sale 2018-03-31 (HPE/Aruba 2915-2920 EoS, 2018); end-of-life. https://asp-documents.arubanetworks.com/portals/0/el/EOS_Notice_2915-2920-Switches.pdf' },
  { key: 'HP 2620', matches: ['HP-2620-24-PoEP'], support_end_date: '2018-10-31', os_eol_date: null, confidence: 'exact', note: 'Aruba/HP 2620 24 PoE+ (J9625A) — End-of-Sale 2018-10-31 (HPE/Aruba 2620 EoS, 2018); end-of-life. https://support.hpe.com/techlib/docs/products/eos/Aruba%202620%20Switch%20-%20External%20-%20April%2030%202018.pdf' },
  // Netgear / D-Link / TP-Link / Ubiquiti (official EOL lists)
  { key: 'NETGEAR GS408EPP', matches: ['Netgear GS408EPP'], support_end_date: '2020-07-01', os_eol_date: null, confidence: 'exact', note: 'Netgear GS408EPP — End-of-Sale 2020-07-01 (Netgear EOL product list). https://downloads1.netgear.com/files/netgear/pdfs/NFB_EOL_Product_List_Dec2025.pdf' },
  { key: 'NETGEAR S3300-28X', matches: ['Netgear S3300-28X'], support_end_date: '2022-04-01', os_eol_date: null, confidence: 'exact', note: 'Netgear S3300-28X (GS728TX) — End-of-Sale 2022-04-01 (Netgear EOL product list). https://downloads1.netgear.com/files/netgear/pdfs/NFB_EOL_Product_List_Dec2025.pdf' },
  { key: 'NETGEAR GS108T', matches: ['Netgear GS108T'], support_end_date: '2021-01-01', os_eol_date: null, confidence: 'exact', note: 'Netgear GS108T v2 — End-of-Sale 2021-01-01 (Netgear EOL product list); v3 still current. https://downloads1.netgear.com/files/netgear/pdfs/NFB_EOL_Product_List_Dec2025.pdf' },
  { key: 'DLINK DGS-1100-24P', matches: ['D-Link DGS-1100-24P'], support_end_date: '2026-02-28', os_eol_date: null, confidence: 'exact', note: 'D-Link DGS-1100-24P — end of technical support 2026-02-28 (D-Link official support page). https://support.dlink.com/ProductInfo.aspx?m=DGS-1100-24P' },
  { key: 'TPLINK EAP225', matches: ['TP-Link EAP225'], support_end_date: '2024-09-21', os_eol_date: null, confidence: 'exact', note: 'TP-Link EAP225 — latest HW version End-of-Sale 2024-09-21 (TP-Link Business EOL list V6.0). https://static.tp-link.com/upload/manual/2025/202509/20250910/EOL%20List_Business_V6.0.pdf' },
  { key: 'UBIQUITI UAP-PRO', matches: ['Ubiquiti UAP PRO'], support_end_date: '2021-03-01', os_eol_date: null, confidence: 'exact', note: 'Ubiquiti UniFi UAP-Pro — obsoletion/EOL 2021-03-01 (Ubiquiti official community announcement). https://community.ui.com/questions/Select-UniFi-Access-Point-AP-Models-Obsoletion-Date-March-1-2021/65487283-ce9d-49f4-85b9-b6aa54659ef7' },
  // SonicWall wireless APs + firewall (SonicWall official Product Lifecycle tables).
  // Aliases include the legacy mislabeled model strings ('Ne INT'/'432e INT') so the
  // ESIP APs get dated even before the model-cleanup SQL is applied.
  { key: 'SONICWALL SONICPOINT-NE', matches: ['SonicPoint-Ne', 'SonicPoint Ne', 'Ne INT'], support_end_date: '2020-10-01', os_eol_date: null, confidence: 'exact', note: 'SonicWall SonicPoint-Ne (802.11n AP) — End of Support 2020-10-01 (end-of-sale 2015-09-30); SonicWall Wireless Access Points hardware lifecycle table. https://www.sonicwall.com/support/product-lifecycle-tables/wireless-access-points/hardware' },
  { key: 'SONICWALL SONICWAVE 432E', matches: ['SonicWave 432e', 'SonicWave-432e', '432e INT'], support_end_date: '2027-04-23', os_eol_date: null, confidence: 'exact', note: 'SonicWall SonicWave 432e (802.11ac Wave 2 AP) — End of Support 2027-04-23 (end-of-sale 2022-04-22); SonicWall Wireless Access Points hardware lifecycle table. https://www.sonicwall.com/support/product-lifecycle-tables/wireless-access-points/hardware' },
  { key: 'SONICWALL NSA 3650', matches: ['NSA 3650'], support_end_date: '2026-08-01', os_eol_date: null, confidence: 'exact', note: 'SonicWall NSA 3650 (Gen6 firewall) — End of Support 2026-08-01 (last order 2022-04-15); SonicWall Last-Day-of-Support announcement. https://www.sonicwall.com/support/product-notification/sonicwall-last-order-day-of-support-announcement-tz-400-tz400w-tz600-tz-600p-nsa-3600-nsa-3650/kA1VN0000000R1u0AE' },
  // Cisco Small Business switches + Aironet (Cisco EoL bulletins)
  { key: 'CISCO SG250-08HP', matches: ['SG250-08HP'], support_end_date: '2026-10-31', os_eol_date: null, confidence: 'exact', note: 'Cisco SG250-08HP (250 Series) — LDoS 2026-10-31 (Cisco EoL c51-2440268; last order 2021-10-30). https://www.cisco.com/c/en/us/products/collateral/switches/250-series-smart-switches/eos-eol-notice-c51-2440268.html' },
  { key: 'CISCO SG200-50', matches: ['SG200-50'], support_end_date: '2020-10-31', os_eol_date: null, confidence: 'family', note: 'Cisco SB 200 Series Smart Switches (SG200-50) — LDoS 2020-10-31 (Cisco EoL c51-740541; series-level). https://www.cisco.com/c/en/us/products/collateral/switches/small-business-smart-switches/eos-eol-notice-c51-740541.html' },
  { key: 'CISCO SG95D-08', matches: ['SG95D-08'], support_end_date: '2026-10-31', os_eol_date: null, confidence: 'family', note: 'Cisco SG95/SG110 Unmanaged Select Models (SG95D-08) — series-level LDoS 2026-10-31 (Cisco EoL c51-2440269; last order 2021-10-30). https://www.cisco.com/c/en/us/products/collateral/switches/110-series-unmanaged-switches/eos-eol-notice-c51-2440269.html' },
  { key: 'CISCO AIRONET 1242AG', matches: ['Cisco Aironet 1242AG', 'AIR-AP1242AG'], support_end_date: '2018-07-31', os_eol_date: null, confidence: 'exact', note: 'Cisco Aironet 1240AG/1242AG — LDoS 2018-07-31 (Cisco EoL c51-726425; EoS 2013). https://www.cisco.com/c/en/us/obsolete/wireless/cisco-aironet-1240-ag-access-point.html' },
  // TP-Link (official Business EOL list V6.0)
  { key: 'TPLINK EAP110-OUTDOOR', matches: ['TP-Link EAP110-Outdoor', 'TP-LINK EAP110-Outdoor'], support_end_date: '2024-09-21', os_eol_date: null, confidence: 'exact', note: 'TP-Link EAP110-Outdoor — latest HW version End-of-Sale 2024-09-21 (TP-Link Business EOL list V6.0). https://static.tp-link.com/upload/manual/2025/202509/20250910/EOL%20List_Business_V6.0.pdf' },

  // ── Researched but UNCONFIRMED (no official vendor EOL date) — intentionally
  //    NOT seeded (no guessing). These are current Wi-Fi 6 / current-gen products:
  //    Aruba 504/505/515/575/615, Aruba 2930F (24G/48G PoE variants), Aruba CX
  //    6000/6100, Grandstream GWN766x, Ruckus R550/R650/T350SE/T350C (current
  //    Wi-Fi 6), Huawei AirEngine 6761/5761 + S5731/S5735/S6730, Cisco
  //    C9200L/C9300/Catalyst-1300, Palo Alto PA-440/PA-460, Forcepoint NGFW
  //    120/120W/330/352, HPE 5140 EI, HP MSM430, TP-Link TL-WA120 (model could not
  //    be verified). Revisit when vendors publish notices.
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
