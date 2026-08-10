import crypto from 'crypto'
import bcrypt from 'bcryptjs'

/**
 * mfa.ts — TOTP (RFC 6238) second factor for the NocVault hub.
 *
 * NetVault is the ONLY place in the suite where a password is verified: the
 * satellites have no login page and authenticate by redeeming a hub-signed SSO
 * token (LogVault and DDIVault each had a second password path until 2.31.11 /
 * 1.30.1, which is why they were closed before this was written). So enforcing a
 * second factor here covers all four apps, and there is no bypass to keep in
 * sync.
 *
 * TOTP is implemented directly on node:crypto rather than pulled from a package.
 * It is a short, fully specified algorithm, the implementation is verified
 * against RFC 6238's own published test vectors in the unit test, and this is
 * authentication code — an auditable 40 lines is worth more here than a
 * dependency whose supply chain we would then own.
 */

// ── Secret encryption at rest ───────────────────────────────────────────────
//
// The TOTP secret is a bearer credential: anyone holding it can mint valid codes
// indefinitely, so storing it in plaintext would mean read access to the users
// table is equivalent to permanently defeating MFA for everyone.
//
// The key is DERIVED from NEXTAUTH_SECRET rather than stored beside the data —
// encrypting with a key that lives in the same database it protects is not
// encryption. Deriving also means no new secret for the installer to generate,
// distribute and back up.
//
// TRADE-OFF, deliberate and documented: rotating NEXTAUTH_SECRET makes existing
// mfa_secret values undecryptable, and affected users must re-enrol. That is
// acceptable because rotating it is already a suite-wide event — it invalidates
// every session and breaks SSO between all four apps — so it is never done
// casually. Backup codes are bcrypt-HASHED, not encrypted, so they keep working
// across a rotation and remain a real recovery path.
const KEY_INFO = 'nocvault-mfa-secret-encryption-v1'
const KEY_SALT = 'nocvault-mfa-v1'

function encryptionKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set — cannot encrypt MFA secrets')
  // HKDF gives a uniformly random 32-byte key from a secret that may be any
  // length/entropy shape, and domain-separates it from the JWT signing use.
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from(KEY_SALT), Buffer.from(KEY_INFO), 32))
}

/** AES-256-GCM. Output: `v1:<base64(iv|tag|ciphertext)>`. */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}

/** Returns null on any failure — a tampered or key-mismatched value is simply
 *  unusable, which callers must treat as "no MFA secret", never as "verified". */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored || !stored.startsWith('v1:')) return null
  try {
    const raw = Buffer.from(stored.slice(3), 'base64')
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const ct = raw.subarray(28)
    const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

// ── Base32 (RFC 4648, unpadded) — the encoding authenticator apps expect ─────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new 160-bit secret, base32 encoded (the size RFC 4226 recommends for SHA-1). */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20))
}

// ── TOTP (RFC 6238) ─────────────────────────────────────────────────────────
export const TOTP_STEP_SECONDS = 30
// ±1 step of tolerance for clock drift between the phone and the server. Each
// extra step widens the window an attacker can replay a captured code in, so
// this stays at 1 — 90 seconds total, the common default.
export const TOTP_WINDOW = 1

/** HOTP for one counter value. */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  // Counter is 64-bit; writing it as two 32-bit halves avoids BigInt and is
  // exact for any timestamp this code will ever see.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(code % 1_000_000).padStart(6, '0')
}

/** The current time step. Exposed so callers can persist it for replay defence. */
export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS)
}

/**
 * Verify a code. Returns the matched STEP (so the caller can reject replays by
 * storing it), or null.
 *
 * `minStep` rejects any step at or below one already used by this account. A
 * code stays valid for up to 90 seconds across the drift window, so without this
 * a code observed once — over the shoulder, in a screenshot, in a proxy log —
 * can be presented again inside that window. TOTP does not prevent replay on its
 * own; the server has to.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  opts: { minStep?: number | null; nowMs?: number } = {}
): number | null {
  const digits = String(token || '').replace(/\D/g, '')
  if (digits.length !== 6) return null
  const secret = base32Decode(secretBase32)
  if (secret.length === 0) return null
  const step = currentStep(opts.nowMs)
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const s = step + d
    if (opts.minStep != null && s <= opts.minStep) continue
    // Constant-time compare so a timing signal can't leak digits.
    const expected = Buffer.from(hotp(secret, s))
    const given = Buffer.from(digits)
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return s
  }
  return null
}

/** The URI an authenticator app scans. */
export function otpauthUri(secretBase32: string, email: string, issuer = 'NocVault'): string {
  const label = encodeURIComponent(`${issuer}:${email}`)
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

// ── Backup codes ────────────────────────────────────────────────────────────
export const BACKUP_CODE_COUNT = 10

/** Human-transcribable: base32 alphabet (no 0/1/O/I ambiguity), grouped. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10)
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`)
  }
  return codes
}

export const normalizeBackupCode = (c: string) => String(c || '').toUpperCase().replace(/[^A-Z2-7]/g, '')

/** Hashed, never encrypted — these must survive a NEXTAUTH_SECRET rotation, and
 *  we only ever need to compare, never to read them back. */
export async function hashBackupCode(code: string): Promise<string> {
  return bcrypt.hash(normalizeBackupCode(code), 10)
}

export async function backupCodeMatches(code: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(normalizeBackupCode(code), hash)
  } catch {
    return false
  }
}

// ── Lockout policy ──────────────────────────────────────────────────────────
// A 6-digit code is one-in-a-million per guess, which is only meaningful if
// guessing is bounded. Without a cap an attacker holding the password can simply
// iterate.
export const MFA_MAX_ATTEMPTS = 5
export const MFA_LOCKOUT_MINUTES = 15
