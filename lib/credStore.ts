import crypto from 'node:crypto'

/**
 * credStore.ts — AES-256-GCM encryption for credentials the hub stores at rest.
 *
 * Today that is the suite-wide SMTP password (`smtp_config.password`), which
 * NetVault is becoming the owner of. See
 * `docs/nocvault-smtp-centralization-plan.md` §2.2 and §4.
 *
 * ── THIS FILE'S ON-DISK FORMAT IS A CROSS-APP CONTRACT ──────────────────────
 *
 * The satellites do NOT ask the hub for the password over HTTP — they read the
 * hub's `smtp_config` row through the `netvault` pool they already hold and
 * decrypt it with their OWN copy of this logic. DDIVault has stored its
 * credentials this way since long before the hub did
 * (`ddivault/collector/credStore.js`), and that implementation is the reference.
 *
 * Both halves of the format must therefore stay byte-identical to DDIVault's:
 *
 *   value       = `${ivHex}:${authTagHex}:${ciphertextHex}`   (hex, not base64)
 *   cipher      = aes-256-gcm, 12-byte (96-bit) random IV
 *   key         = sha256(NEXTAUTH_SECRET)                     (a plain digest)
 *
 * `NEXTAUTH_SECRET` is the same value in all four apps because it is the SSO
 * signing secret, so no new key distribution is needed — and equally, this
 * encryption defends against a DB dump and against the readonly diagnostic
 * roles, NOT against a sibling app. Do not reason about it as app isolation.
 *
 * ⛔ Changing the format, the IV length, or the key derivation here breaks every
 * satellite's ability to read the hub's password. `tests/credStore.test.ts`
 * pins it with a fixed vector produced by DDIVault's own module. If that test
 * fails, the fix is to restore compatibility — never to regenerate the vector.
 *
 * NOTE this deliberately does NOT follow `lib/mfa.ts`, NetVault's other
 * AES-256-GCM helper. That one uses HKDF and a `v1:<base64>` envelope, which is
 * a better shape in isolation — but it is read by exactly one app, so it is free
 * to choose. This one is not.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // 96-bit IV, the size GCM is specified for — and DDIVault's

/**
 * ⛔ The secret is read from `process.env` INSIDE each call, never once at module
 * scope. Next.js evaluates module scope at BUILD time, so a module-level read
 * would bake in whatever the build host had — or, far more likely, `undefined`,
 * since the build does not run under the NSSM service env that actually carries
 * NEXTAUTH_SECRET at runtime.
 */
function secret(): string | undefined {
  const s = process.env.NEXTAUTH_SECRET
  return typeof s === 'string' && s.length > 0 ? s : undefined
}

/**
 * ⛔ NEVER `process.env.X || 'some-literal'` here. A fallback literal is a
 * publicly known key: every install that ever hit the fallback would have its
 * credentials encrypted with a value sitting in a public-ish repo, and — worse —
 * it fails silently, so nobody finds out. The suite has a recorded incident for
 * exactly this (ddivault 1.22.5). Refuse instead; see `encryptCred`.
 */
function key(s: string): Buffer {
  // A plain SHA-256 digest, NOT HKDF — part of the contract above.
  return crypto.createHash('sha256').update(s).digest()
}

/** True when a usable `NEXTAUTH_SECRET` is configured. */
export function credSecretConfigured(): boolean {
  return secret() !== undefined
}

/**
 * Encrypt a credential. Returns `"ivHex:authTagHex:ciphertextHex"`.
 *
 * ⛔ DO NOT move this failure to module load, even though DDIVault's copy throws
 * at `require()` time. DDIVault's credStore is loaded by a backend service whose
 * whole job needs the key, so refusing to start is the correct, visible
 * behaviour there. THIS module is imported by Next.js route handlers: a throw at
 * import time is evaluated when the route module is first loaded and would take
 * down unrelated pages and APIs — turning "SMTP is not configured yet" into "the
 * hub is broken". The write path is the right place to be loud, because that is
 * the only moment where proceeding would persist a credential under a key we
 * cannot vouch for. This is the single most likely thing for a future reader to
 * "fix" back towards DDIVault's shape; please don't.
 */
export function encryptCred(plaintext: string): string {
  if (!plaintext) return ''
  const s = secret()
  if (!s) {
    // Storing a credential under a guessable key is worse than refusing to store
    // it: the operator believes it is protected.
    throw new Error(
      'NEXTAUTH_SECRET is not set — refusing to encrypt a stored credential. ' +
        'It derives the AES-256-GCM key for lib/credStore.ts, and there is no ' +
        'safe fallback for a security-relevant secret.',
    )
  }
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key(s), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`
}

/**
 * Decrypt a credential. Returns `''` on ANY failure — no secret, malformed
 * input, a tampered ciphertext the GCM tag rejects, or a value written under a
 * different `NEXTAUTH_SECRET`. It never throws.
 *
 * A tampered or key-mismatched value is simply unusable, so callers must treat
 * `''` as "no password configured" and never as "verified" (the same rule
 * `lib/mfa.ts`'s `decryptSecret` states for its `null`). The read path stays
 * quiet on purpose: a decrypt failure must not take out the settings page that
 * an admin would use to re-enter the password.
 */
export function decryptCred(encrypted: string): string {
  if (!encrypted) return ''
  const s = secret()
  if (!s) return ''
  try {
    const [ivHex, tagHex, encHex] = encrypted.split(':')
    if (!ivHex || !tagHex || !encHex) return ''
    const decipher = crypto.createDecipheriv(ALGORITHM, key(s), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Shape check only — does this look like one of our stored values rather than a
 * plaintext password someone pasted in? Identical to DDIVault's `isEncrypted`:
 * three colon-separated parts, a 24-hex-char IV and a 32-hex-char auth tag.
 *
 * This proves NOTHING about authenticity; only `decryptCred` does.
 */
export function isEncryptedCred(str: string): boolean {
  if (!str) return false
  const parts = str.split(':')
  return parts.length === 3 && parts[0].length === 24 && parts[1].length === 32
}
