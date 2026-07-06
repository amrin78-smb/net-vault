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
