import { query } from '@/lib/db'
import {
  decryptSecret,
  verifyTotp,
  backupCodeMatches,
  MFA_MAX_ATTEMPTS,
  MFA_LOCKOUT_MINUTES,
} from '@/lib/mfa'

/**
 * mfaGate.ts — the server-side second-factor decision.
 *
 * Deliberately ONE function used by both callers (NextAuth's authorize() and
 * /api/auth/mfa/precheck). Attempt counting, lockout and replay defence only
 * work if every path shares the same state machine; two copies drift, and the
 * copy that drifts is the one an attacker uses.
 */

export type MfaFailure = 'locked' | 'bad_code' | 'no_secret'

export interface MfaResult {
  ok: boolean
  reason?: MfaFailure
  usedBackupCode?: boolean
  /** Seconds remaining on a lockout, for the UI to show something honest. */
  retryAfterSeconds?: number
}

/** Roles that must have MFA, from app_settings.mfa_required_roles (JSON array). */
export async function mfaRequiredForRole(role: string): Promise<boolean> {
  try {
    const res = await query("SELECT value FROM app_settings WHERE key = 'mfa_required_roles'")
    const raw = res.rows[0]?.value
    if (!raw) return false
    const roles = JSON.parse(raw)
    return Array.isArray(roles) && roles.includes(role)
  } catch {
    // Unreadable policy must not lock everyone out of the hub — and it cannot
    // grant anything either: this only decides whether to DEMAND enrolment from
    // someone who has none. A user who HAS enabled MFA is still challenged,
    // because that branch never consults this function.
    return false
  }
}

/**
 * Verify a submitted code against a user row (which must already have passed the
 * password check). Handles lockout, TOTP replay and backup codes.
 *
 * `user` is the full row; only the mfa_* columns are read.
 */
export async function verifySecondFactor(user: any, submitted: string): Promise<MfaResult> {
  const now = new Date()

  // ── Lockout ──
  if (user.mfa_locked_until && new Date(user.mfa_locked_until) > now) {
    const secs = Math.ceil((new Date(user.mfa_locked_until).getTime() - now.getTime()) / 1000)
    return { ok: false, reason: 'locked', retryAfterSeconds: secs }
  }

  const secret = decryptSecret(user.mfa_secret)
  if (!secret) {
    // Enabled but the secret cannot be decrypted — most likely NEXTAUTH_SECRET
    // was rotated. FAIL CLOSED on the TOTP path, but still allow a backup code
    // below, since those are hashed and survive rotation. That is the difference
    // between "re-enrol at your convenience" and "locked out permanently".
    const viaBackup = await tryBackupCode(user.id, submitted)
    if (viaBackup) {
      await resetAttempts(user.id)
      return { ok: true, usedBackupCode: true }
    }
    await registerFailure(user)
    return { ok: false, reason: 'no_secret' }
  }

  // ── TOTP, with replay defence ──
  const step = verifyTotp(secret, submitted, { minStep: user.mfa_last_step ?? null })
  if (step != null) {
    // Record the accepted step so this code (and any earlier one still inside
    // the drift window) cannot be presented again.
    await query(
      'UPDATE users SET mfa_last_step = $1, mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = $2',
      [step, user.id]
    )
    return { ok: true }
  }

  // ── Backup code ──
  if (await tryBackupCode(user.id, submitted)) {
    await resetAttempts(user.id)
    return { ok: true, usedBackupCode: true }
  }

  await registerFailure(user)
  return { ok: false, reason: 'bad_code' }
}

/** Consume a single unused backup code. Returns true if one matched. */
async function tryBackupCode(userId: number, submitted: string): Promise<boolean> {
  const candidate = String(submitted || '').trim()
  if (candidate.length < 8) return false // a 6-digit TOTP can never be a backup code
  const res = await query(
    'SELECT id, code_hash FROM user_mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  )
  for (const row of res.rows) {
    if (await backupCodeMatches(candidate, row.code_hash)) {
      // Mark used in the same statement that checks it is still unused, so two
      // concurrent logins cannot both spend the same code.
      const upd = await query(
        'UPDATE user_mfa_backup_codes SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id',
        [row.id]
      )
      return (upd.rowCount ?? 0) > 0
    }
  }
  return false
}

async function resetAttempts(userId: number) {
  await query('UPDATE users SET mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = $1', [userId])
}

async function registerFailure(user: any) {
  const attempts = (user.mfa_failed_attempts || 0) + 1
  if (attempts >= MFA_MAX_ATTEMPTS) {
    await query(
      `UPDATE users SET mfa_failed_attempts = 0,
                        mfa_locked_until = NOW() + make_interval(mins => $1)
       WHERE id = $2`,
      [MFA_LOCKOUT_MINUTES, user.id]
    )
  } else {
    await query('UPDATE users SET mfa_failed_attempts = $1 WHERE id = $2', [attempts, user.id])
  }
}
