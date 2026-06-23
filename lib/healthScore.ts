import { query } from '@/lib/db'
import { computeCompliance } from '@/lib/compliance'

/**
 * Shared infrastructure health-score calculation.
 *
 * Used by BOTH /api/dashboard/overview (live read) and
 * /api/system/health-snapshot (daily persisted snapshot) so the score, grade
 * and metrics are computed identically in every place.
 *
 * The compliance input is the REAL Risk/Compliance score from lib/compliance
 * (weighted pass-rate of policy checks whose fields are actually populated) —
 * NOT the old completeness-polluted average that penalised structurally empty
 * columns. This keeps the health grade a measure of real risk.
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
  // Real Risk/Compliance score (weighted, only checks whose fields are tracked).
  const compliance_score = (await computeCompliance(activeBase)).score

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
