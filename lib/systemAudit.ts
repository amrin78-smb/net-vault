//
// lib/systemAudit.ts — record a change to a SYSTEM setting in the audit trail.
//
// ⛔ WHY THIS EXISTS AT ALL. A super_admin who repoints `ENTRA_TENANT_ID` at a
// tenant they control, maps a group they own to super_admin and signs in has
// escalated past every other guard in this product without touching the Users
// page. That is the single action most worth having a record of, and until now
// it left none.
//
// ⛔ IT REUSES `audit_log` RATHER THAN ADDING A TABLE, following the precedent
// `app/api/admin/users/[id]/mfa-reset/route.ts` already set. NetVault's
// audit_log is DEVICE-SHAPED (device_id, changed_by, field_name, old_value,
// new_value) — not LogVault's (action, entity_type, details) — and `device_id`
// is nullable, so a system event records NULL there and identifies itself in
// `field_name`. `/api/audit` LEFT JOINs devices, so these rows render correctly
// in the existing Audit Log page with no query change. A second audit table
// would split the trail in half, and the half someone checks would be the wrong
// one.

import { query } from './db.ts'

/** The settings this module will record. Mirrors envTargets' MANAGED_KEYS. */
export const AUDITED_KEYS = [
  'NEXTAUTH_URL',
  'TLS_CERT_PATH',
  'TLS_KEY_PATH',
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'ENTRA_CLIENT_SECRET',
] as const
export type AuditedKey = (typeof AUDITED_KEYS)[number]

/**
 * Keys whose VALUE must never reach the audit trail.
 *
 * ⛔ AN AUDIT ROW IS READ BY MORE PEOPLE THAN THE SETTING ITSELF. The Entra
 * client secret is write-only everywhere else in this product — the API never
 * returns it, the Settings panel cannot pre-fill it, and `entraSettings.ts`
 * compares saved against running SERVER-SIDE so that only a field LABEL
 * travels. Writing the value into `audit_log` would undo all of that in one
 * line, and put it somewhere `claude_readonly`-class roles and the Audit Log
 * page can read it.
 *
 * ⛔ THE REDACTION IS KEYED ON THE SETTING, NOT ON THE VALUE'S SHAPE. A
 * heuristic ("does it look like a secret?") fails open on the one input that
 * matters — the commonest misconfiguration in this panel is pasting the client
 * secret into an ID box, at which point the value stored under
 * `ENTRA_TENANT_ID` IS the secret. So ALL THREE Entra fields are recorded as
 * presence only, not just the secret.
 */
const VALUE_NEVER_RECORDED: ReadonlySet<string> = new Set<string>([
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'ENTRA_CLIENT_SECRET',
])

/** What a redacted value is recorded as. Presence, never content. */
export const PRESENT = '(set)'
export const ABSENT = '(not set)'

/**
 * What to write into `old_value` / `new_value` for one key.
 *
 * ⛔ PURE, so the redaction rule is testable without a database. A rule that
 * can only be exercised by writing a real audit row is a rule nobody checks.
 */
export function auditValue(key: string, value: string | null | undefined): string {
  const v = typeof value === 'string' ? value.trim() : ''
  if (VALUE_NEVER_RECORDED.has(key)) return v === '' ? ABSENT : PRESENT
  // Not a secret: the whole point of auditing a console address or a
  // certificate PATH is being able to see what it was changed to.
  return v === '' ? ABSENT : v
}

/** True when a change is worth a row at all. */
export function auditWorthRecording(
  key: string,
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  // ⛔ Compared on the RAW values, not on the redacted ones. Two different
  // secrets both redact to "(set)", so comparing after redaction would record
  // nothing when a secret is ROTATED — the change most worth knowing about.
  const a = typeof from === 'string' ? from.trim() : ''
  const b = typeof to === 'string' ? to.trim() : ''
  return a !== b
}

export type SystemAuditEntry = {
  key: string
  from: string | null | undefined
  to: string | null | undefined
}

/**
 * Record one or more system-setting changes.
 *
 * ⛔ BEST-EFFORT, AND LOUD ON FAILURE — the same call `mfa-reset` makes, for the
 * same reason. A failed audit insert must not leave the setting half-saved or
 * bounce an operator who did nothing wrong; but it must never pass unnoticed,
 * because an audit trail that silently stops recording is worse than none (it
 * is read later as evidence that nothing happened).
 *
 * @param actorId `session.user.id` — ⛔ FROM THE SESSION, NEVER FROM A REQUEST
 *   BODY. An actor a caller can choose is not an audit trail.
 */
export async function recordSystemChanges(
  actorId: number | string | null | undefined,
  entries: SystemAuditEntry[],
): Promise<void> {
  const actor = typeof actorId === 'string' ? parseInt(actorId, 10) : actorId
  const rows = entries.filter((e) => auditWorthRecording(e.key, e.from, e.to))
  if (rows.length === 0) return

  for (const e of rows) {
    try {
      await query(
        `INSERT INTO audit_log (device_id, changed_by, field_name, old_value, new_value)
         VALUES (NULL, $1, $2, $3, $4)`,
        [
          Number.isFinite(actor as number) ? actor : null,
          `system_setting:${e.key}`,
          auditValue(e.key, e.from),
          auditValue(e.key, e.to),
        ],
      )
    } catch (err) {
      console.error(
        `[system-audit] AUDIT WRITE FAILED for ${e.key} — the setting was changed but NOT recorded:`,
        err,
      )
    }
  }
}
