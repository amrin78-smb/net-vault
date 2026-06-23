import { query } from '@/lib/db'

/**
 * Shared compliance computation — single source of truth used by BOTH
 * /api/compliance (the dashboard) and lib/healthScore (the health grade) so the
 * two never diverge.
 *
 * TWO distinct metrics are produced from the same per-check measurement:
 *
 *  1. RISK / COMPLIANCE score — the share of *applicable* checks that pass,
 *     lightly weighted toward security-relevant checks. A check is "applicable"
 *     only if its underlying field is populated on at least MIN_POP_PCT of the
 *     active fleet. Checks whose field is essentially empty (e.g. an EOL
 *     enrichment column nobody has filled yet) are NOT counted as failing — they
 *     are surfaced under Data Completeness as "not yet tracked".
 *
 *  2. DATA COMPLETENESS score — how populated the inventory is, averaged across
 *     the field-population checks. This is where empty-field penalties belong.
 *
 * Because applicability is decided at RUNTIME from live population %, the model
 * is future-proof: once an enrichment job populates support_end_date /
 * os_eol_date past the threshold, those checks AUTO-REACTIVATE into the risk
 * score with no code change.
 */

// A check must have its field populated on >= this % of active devices to count
// toward the Risk/Compliance score. Below it, the check is "not yet tracked".
export const MIN_POP_PCT = 5

type CheckKind = 'risk' | 'completeness'

type CheckDef = {
  key: string
  label: string
  href: string
  /** SQL predicate (without the active base) that selects FAILING devices. */
  failPredicate: string
  /** SQL predicate that selects devices whose underlying field is POPULATED. */
  popPredicate: string
  /** Relative weight in the risk score; security-relevant checks weigh more. */
  weight: number
  /**
   * 'risk'        → a real policy violation (counts toward Risk/Compliance).
   * 'completeness'→ an empty-field check (counts toward Data Completeness only).
   * Risk checks can still fall into "not tracked" at runtime if their field is
   * under-populated; completeness checks never enter the risk score.
   */
  kind: CheckKind
}

const CHECK_DEFS: CheckDef[] = [
  // ── Real risk / policy checks ──────────────────────────────────────────────
  {
    key: 'eol_active', label: 'EOL/EOS devices still Active',
    href: '/devices?lifecycle=EOL+%2F+EOS',
    failPredicate: `lifecycle_status = 'EOL / EOS'`,
    popPredicate: `lifecycle_status IS NOT NULL AND lifecycle_status <> ''`,
    weight: 2, kind: 'risk',
  },
  {
    key: 'expired_support', label: 'Devices with expired support contract',
    href: '/devices?support_expiry=expired',
    failPredicate: `support_end_date IS NOT NULL AND support_end_date < CURRENT_DATE`,
    popPredicate: `support_end_date IS NOT NULL`,
    weight: 1.5, kind: 'risk',
  },
  {
    key: 'missing_site', label: 'Devices missing site assignment',
    href: '/devices',
    failPredicate: `(site IS NULL OR site = '' OR site_id IS NULL)`,
    popPredicate: `site IS NOT NULL AND site <> '' AND site_id IS NOT NULL`,
    weight: 1, kind: 'risk',
  },
  {
    key: 'missing_type', label: 'Devices missing device type',
    href: '/devices',
    failPredicate: `(device_type IS NULL OR device_type = '')`,
    popPredicate: `device_type IS NOT NULL AND device_type <> ''`,
    weight: 1, kind: 'risk',
  },

  // ── Data-completeness checks (population of identifying inventory fields) ───
  {
    key: 'missing_serial', label: 'Devices missing serial number',
    href: '/devices',
    failPredicate: `(serial_number IS NULL OR serial_number = '')`,
    popPredicate: `serial_number IS NOT NULL AND serial_number <> ''`,
    weight: 1, kind: 'completeness',
  },
  {
    key: 'missing_ip', label: 'Devices missing IP address',
    href: '/devices',
    failPredicate: `(ip_address IS NULL OR ip_address::text = '')`,
    popPredicate: `ip_address IS NOT NULL AND ip_address::text <> ''`,
    weight: 1, kind: 'completeness',
  },
  {
    key: 'missing_vendor', label: 'Devices missing purchase vendor',
    href: '/devices',
    failPredicate: `(purchase_vendor IS NULL OR purchase_vendor = '')`,
    popPredicate: `purchase_vendor IS NOT NULL AND purchase_vendor <> ''`,
    weight: 1, kind: 'completeness',
  },
  {
    key: 'missing_contract', label: 'Devices missing support contract #',
    href: '/devices',
    failPredicate: `(support_contract_number IS NULL OR support_contract_number = '')`,
    popPredicate: `support_contract_number IS NOT NULL AND support_contract_number <> ''`,
    weight: 1, kind: 'completeness',
  },
]

export type ComplianceCheck = {
  key: string
  label: string
  href: string
  kind: CheckKind
  weight: number
  total: number
  /** null when the column does not exist on this server. */
  fail: number | null
  pass: number | null
  /** pass / total, as a %. null when unavailable. */
  pct: number | null
  /** populated devices for this field. */
  populated: number | null
  /** populated / total, as a %. null when unavailable. */
  populationPct: number | null
  /** column resolves on this server. */
  available: boolean
  /**
   * Population >= MIN_POP_PCT, so the field is actually tracked and the check
   * is eligible to influence the Risk/Compliance score.
   */
  tracked: boolean
  /**
   * Counts toward the Risk/Compliance score right now (kind === 'risk' AND
   * available AND tracked).
   */
  activeInRisk: boolean
}

export type ComplianceResult = {
  /** Real policy-violation score: weighted pass-rate of active risk checks. */
  score: number
  /** How populated the inventory is (field-population checks averaged). */
  completenessScore: number
  total: number
  checks: ComplianceCheck[]
  /** Number of risk checks currently counted in `score`. */
  riskActiveCount: number
  /** Number of risk checks parked in the "not yet tracked" bucket. */
  notTrackedCount: number
  minPopPct: number
}

async function safeCount(sql: string): Promise<number | null> {
  try {
    const res = await query(sql)
    return parseInt(res.rows[0]?.n ?? '0') || 0
  } catch (err) {
    // Column may not exist on this server yet.
    console.error('[compliance] query failed (column may not exist yet):', err)
    return null
  }
}

/**
 * Compute compliance for the given active-device base predicate.
 * `activeBase` is the full WHERE body, e.g. `device_status = 'Active'`
 * optionally prefixed with a site-scoping clause.
 */
export async function computeCompliance(activeBase: string): Promise<ComplianceResult> {
  const totalRes = await safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase}`)
  const total = totalRes ?? 0

  const checks: ComplianceCheck[] = await Promise.all(
    CHECK_DEFS.map(async (def): Promise<ComplianceCheck> => {
      const [fail, populated] = await Promise.all([
        safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND ${def.failPredicate}`),
        safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND ${def.popPredicate}`),
      ])

      const available = fail !== null && populated !== null
      if (!available || total === 0) {
        return {
          key: def.key, label: def.label, href: def.href, kind: def.kind, weight: def.weight,
          total, fail, pass: fail === null ? null : total - fail,
          pct: total === 0 ? 100 : null,
          populated, populationPct: total === 0 ? 100 : null,
          available, tracked: false, activeInRisk: false,
        }
      }

      const pass = total - fail!
      const pct = Math.round((pass / total) * 100)
      const populationPct = Math.round((populated! / total) * 100)
      const tracked = (populated! / total) * 100 >= MIN_POP_PCT
      const activeInRisk = def.kind === 'risk' && tracked

      return {
        key: def.key, label: def.label, href: def.href, kind: def.kind, weight: def.weight,
        total, fail, pass, pct, populated, populationPct,
        available: true, tracked, activeInRisk,
      }
    })
  )

  // Risk/Compliance: weighted pass-rate of the checks active in risk right now.
  const riskChecks = checks.filter(c => c.activeInRisk)
  const weightSum = riskChecks.reduce((s, c) => s + c.weight, 0)
  const score = weightSum > 0
    ? Math.round(riskChecks.reduce((s, c) => s + c.pct! * c.weight, 0) / weightSum)
    : 100

  // Data Completeness: average population % across the completeness-kind checks
  // (these measure how filled the identifying inventory fields are).
  const complChecks = checks.filter(c => c.kind === 'completeness' && c.populationPct !== null)
  const completenessScore = complChecks.length > 0
    ? Math.round(complChecks.reduce((s, c) => s + c.populationPct!, 0) / complChecks.length)
    : 100

  // "Not yet tracked": risk checks whose field is under-populated (or missing).
  const notTrackedCount = checks.filter(c => c.kind === 'risk' && (!c.available || !c.tracked)).length

  return {
    score,
    completenessScore,
    total,
    checks,
    riskActiveCount: riskChecks.length,
    notTrackedCount,
    minPopPct: MIN_POP_PCT,
  }
}
