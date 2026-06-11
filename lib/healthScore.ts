import { query } from '@/lib/db'

/**
 * Shared infrastructure health-score calculation.
 *
 * Used by BOTH /api/dashboard/overview (live read) and
 * /api/system/health-snapshot (daily persisted snapshot) so the score, grade
 * and metrics are computed identically in every place.
 */

export type HealthResult = {
  health_score: number
  health_grade: 'A' | 'B' | 'C' | 'D' | 'F'
  overall_status: 'Healthy' | 'Warning' | 'Critical'
  status_description: string
  healthy_devices: number
  healthy_devices_pct: number
  eol_assets: number
  eol_assets_pct: number
  sites_at_risk: number
  compliance_score: number
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

async function safeCount(sql: string): Promise<number> {
  try {
    const res = await query(sql)
    return parseInt(res.rows[0]?.n ?? res.rows[0]?.total ?? '0') || 0
  } catch (err) {
    console.error('[healthScore] query failed:', err)
    return 0
  }
}

// Reuse compliance logic inline; default to 100 (neutral) if anything fails.
async function computeComplianceScore(activeBase: string): Promise<number> {
  try {
    const totalRes = await query(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase}`)
    const total = parseInt(totalRes.rows[0]?.n ?? '0') || 0
    if (total === 0) return 100

    const checkSqls = [
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (serial_number IS NULL OR serial_number = '')`,
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (ip_address IS NULL OR ip_address::text = '')`,
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (purchase_vendor IS NULL OR purchase_vendor = '')`,
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (support_contract_number IS NULL OR support_contract_number = '')`,
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND support_end_date IS NULL`,
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND support_end_date IS NOT NULL AND support_end_date < CURRENT_DATE`,
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND lifecycle_status = 'EOL / EOS'`,
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (site IS NULL OR site = '' OR site_id IS NULL)`,
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (device_type IS NULL OR device_type = '')`,
    ]

    const pcts: number[] = []
    for (const sql of checkSqls) {
      try {
        const res = await query(sql)
        const fail = parseInt(res.rows[0]?.n ?? '0') || 0
        pcts.push(Math.round(((total - fail) / total) * 100))
      } catch {
        // column may not exist — skip this check
      }
    }

    if (pcts.length === 0) return 100
    return Math.round(pcts.reduce((s, p) => s + p, 0) / pcts.length)
  } catch (err) {
    console.error('[healthScore] compliance failed, defaulting to 100:', err)
    return 100
  }
}

/**
 * Compute the live infrastructure health score and its component metrics.
 * Pass `siteIds` to scope the calculation (site-admin view); omit for the
 * global fleet score (used by the daily snapshot).
 */
export async function computeHealthScore(opts: { siteIds?: number[] } = {}): Promise<HealthResult> {
  const siteIds = opts.siteIds ?? []
  const scoped = siteIds.length > 0

  const siteFilter = scoped ? `AND site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''
  const vFilter = scoped ? `WHERE site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''
  const sitePrefix = scoped ? `site_id = ANY(ARRAY[${siteIds.join(',')}]) AND ` : ''
  const activeBase = `${sitePrefix}device_status = 'Active'`

  const total_devices = await safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat ${vFilter}`)
  const eol_assets = await safeCount(
    `SELECT COUNT(*) AS n FROM v_devices_flat WHERE lifecycle_status = 'EOL / EOS' ${siteFilter}`
  )
  const healthy_devices = await safeCount(
    `SELECT COUNT(*) AS n FROM v_devices_flat WHERE device_status = 'Active' AND lifecycle_status <> 'EOL / EOS' ${siteFilter}`
  )
  const total_sites = scoped
    ? siteIds.length
    : await safeCount(`SELECT COUNT(*) AS n FROM sites`)
  const sites_at_risk = await safeCount(
    `SELECT COUNT(DISTINCT site_id) AS n FROM v_devices_flat WHERE lifecycle_status = 'EOL / EOS' AND site_id IS NOT NULL ${siteFilter}`
  )
  const compliance_score = await computeComplianceScore(activeBase)

  const eol_assets_pct = total_devices > 0 ? Math.round((eol_assets / total_devices) * 100) : 0
  const healthy_devices_pct = total_devices > 0 ? Math.round((healthy_devices / total_devices) * 100) : 0

  const eolPenalty = (total_devices > 0 ? (eol_assets / total_devices) * 100 : 0) * 0.4
  const siteRiskPenalty = total_sites > 0 ? (sites_at_risk / total_sites) * 30 : 0
  const compliancePenalty = ((100 - compliance_score) / 100) * 30
  const health_score = clamp(Math.round(100 - eolPenalty - siteRiskPenalty - compliancePenalty), 0, 100)

  const health_grade: HealthResult['health_grade'] =
    health_score >= 90 ? 'A' :
    health_score >= 80 ? 'B' :
    health_score >= 70 ? 'C' :
    health_score >= 60 ? 'D' : 'F'

  const overall_status: HealthResult['overall_status'] =
    health_score >= 75 ? 'Healthy' :
    health_score >= 50 ? 'Warning' : 'Critical'

  const status_description =
    overall_status === 'Healthy' ? 'All systems operating within normal parameters' :
    overall_status === 'Warning' ? 'Some assets need attention' :
    'Immediate action required'

  return {
    health_score,
    health_grade,
    overall_status,
    status_description,
    healthy_devices,
    healthy_devices_pct,
    eol_assets,
    eol_assets_pct,
    sites_at_risk,
    compliance_score,
  }
}
