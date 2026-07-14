import { execSync } from 'child_process'
import { createHash, createDecipheriv } from 'crypto'
import os from 'os'

// SECURITY TRADE-OFF (reviewed 2026-07-14, kept as-is — do not "fix" this into
// a fail-fast the way ddivault's api/emailer.js NEXTAUTH_SECRET fallback was
// fixed in commit 4f53641): that ddivault fix was safe because NEXTAUTH_SECRET
// is auto-generated per install by the suite installer (secrets.env), so it is
// always actually set in practice. NETVAULT_LICENSE_SECRET is different: no
// installer/updater script (Install-NetVault.ps1, Update-NetVault.ps1,
// Install-NocVault-Suite.ps1) or .env.example ever provisions it — it is never
// set on any existing install. Making this fail loudly on a missing env var
// would brick license validation on every current production install, not
// just guard a theoretical path.
//
// The literal below is therefore the REAL, deliberate, permanent shared AES
// key used to derive/validate every purchased license key across ALL
// installs today (the env var only exists as an unused rotation hook — set it
// on a given server and that server alone would need re-issued keys). Anyone
// with filesystem/repo read access to this literal can, with knowledge of the
// LicensePayload shape and a target serverId, forge a valid license key and
// bypass the trial/paywall. This is accepted for now because NetVault is an
// on-prem product with no server-side license-server to check keys against —
// there is no online revocation/verification step this secret could be
// swapped out for without adding one. If that risk profile changes (e.g. this
// becomes a higher-value licensing target), the real fix is switching to
// asymmetric signing (keep a private signing key out of this repo entirely,
// ship only the public key here) rather than a shared symmetric secret.
const LICENSE_SECRET = process.env.NETVAULT_LICENSE_SECRET || 'NocVault-License-Secret-2026-X9K' // 32 chars
const TRIAL_DAYS = 30
const GRACE_DAYS = 7

function getMachineGuid(): string {
  try {
    const result = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: 'utf8', timeout: 3000 }
    )
    const match = result.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

// The server ID is constant for the life of the process (hostname + MachineGuid
// never change at runtime), so memoize it to avoid the synchronous execSync
// registry query blocking the event loop on every /api/license request.
let _serverId: string | null = null

export function getServerId(): string {
  if (_serverId !== null) return _serverId
  const machineGuid = getMachineGuid()
  const hostname = os.hostname()
  const raw = `${hostname}-${machineGuid}`
  const hash = createHash('sha256').update(raw).digest('hex').substring(0, 32)
  _serverId = `NCV-${hash}`
  return _serverId
}

export interface LicensePayload {
  customer: string
  serverId: string
  expiry: string
  modules: string[]
  maxDevices: number
  issuedAt: string
}

export function validateLicenseKey(key: string, serverId: string): {
  valid: boolean
  payload?: LicensePayload
  error?: string
} {
  try {
    const decoded = Buffer.from(key.trim(), 'base64').toString('utf8')
    const colonIdx = decoded.indexOf(':')
    if (colonIdx === -1) throw new Error('bad format')
    const ivHex = decoded.substring(0, colonIdx)
    const encrypted = decoded.substring(colonIdx + 1)
    const iv = Buffer.from(ivHex, 'hex')
    const secretKey = createHash('sha256').update(LICENSE_SECRET).digest()
    const decipher = createDecipheriv('aes-256-cbc', secretKey, iv)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    const payload: LicensePayload = JSON.parse(decrypted)
    if (payload.serverId !== serverId) {
      return { valid: false, error: 'License key is not valid for this server' }
    }
    if (new Date(payload.expiry) < new Date()) {
      return { valid: false, error: 'License key has expired', payload }
    }
    return { valid: true, payload }
  } catch {
    return { valid: false, error: 'Invalid license key format' }
  }
}

export function getTrialDaysRemaining(installDate: string): number {
  if (!installDate) return TRIAL_DAYS
  const install = new Date(installDate)
  const now = new Date()
  const daysSinceInstall = Math.floor(
    (now.getTime() - install.getTime()) / (1000 * 60 * 60 * 24)
  )
  return TRIAL_DAYS - daysSinceInstall
}

export type LicenseStatus = 'trial' | 'active' | 'expired' | 'grace'

export function getLicenseStatus(
  installDate: string,
  licenseKey: string,
  serverId: string
): {
  status: LicenseStatus
  daysRemaining: number
  payload?: LicensePayload
} {
  // Check for a valid active license first
  if (licenseKey && licenseKey.trim()) {
    const result = validateLicenseKey(licenseKey, serverId)
    if (result.valid && result.payload) {
      const expiry = new Date(result.payload.expiry)
      const now = new Date()
      const daysRemaining = Math.ceil(
        (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      )
      return { status: 'active', daysRemaining, payload: result.payload }
    }
  }

  // Fall back to trial / expired logic
  const trialDaysRemaining = getTrialDaysRemaining(installDate)

  if (trialDaysRemaining > 0) {
    return { status: 'trial', daysRemaining: trialDaysRemaining }
  } else if (trialDaysRemaining >= -GRACE_DAYS) {
    return { status: 'grace', daysRemaining: trialDaysRemaining }
  } else {
    return { status: 'expired', daysRemaining: trialDaysRemaining }
  }
}

// Used by API write routes to gate mutations when fully expired
export function isWriteAllowed(status: LicenseStatus): boolean {
  return status === 'trial' || status === 'active' || status === 'grace'
}
