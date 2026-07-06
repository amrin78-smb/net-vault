/**
 * Remove a redundant leading brand name from a device model string.
 *
 * NetVault stores brand and model as separate fields, but some import sources bake
 * the brand into the model ("Cisco SW 500", "Aruba 505"), which then renders as
 * "Cisco Cisco SW 500" / "Aruba Aruba 505" (the device list shows `${brand} ${model}`).
 * This strips the leading brand word — plus a following "Networking" so the full
 * "Aruba Networking" vendor name is handled — leaving just the model designation.
 *
 * Product lines are preserved (Catalyst, Aironet, Instant On, NGFW, MSM, RackSwitch,
 * …) because only the exact leading brand token is removed. Never returns an empty
 * string: if stripping would blank the model, the original is kept.
 *
 * This MUST stay equivalent to the one-time SQL cleanup in
 * `scripts/cleanup-brand-in-model.sql` so import-time and the bulk cleanup agree.
 */
/**
 * Canonicalize a brand string from an import cell (fix known spelling variants).
 * Shared by the CSV importer and its preview so both resolve the same brand — which
 * matters for stripBrandFromModel(), whose prefix match must use the canonical spelling
 * (e.g. cell "Tplink" → "TP-Link" so "TP-Link EAP225" strips correctly).
 */
export function normaliseBrand(b: string | null | undefined): string {
  const map: Record<string, string> = { 'CISCO': 'Cisco', 'ForcePoint': 'Forcepoint', 'Forcepoint ': 'Forcepoint', 'Netgear ': 'Netgear', 'D-Link ': 'D-Link', 'Dlink': 'D-Link', 'Tplink': 'TP-Link', 'Totolink': 'TOTOLINK' }
  const t = (b ?? '').trim()
  return map[t] || t
}

export function stripBrandFromModel(
  brand: string | null | undefined,
  model: string | null | undefined
): string | null {
  const original = model ?? null
  const m = (model ?? '').trim()
  const b = (brand ?? '').trim()
  if (!m || !b) return original
  if (m.toLowerCase().startsWith(b.toLowerCase() + ' ')) {
    let out = m.slice(b.length).replace(/^\s+/, '')
    out = out.replace(/^networking\s+/i, '') // "Aruba Networking CX 6300M" -> "CX 6300M"
    out = out.trim()
    if (out) return out
  }
  return original
}
