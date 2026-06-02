import { execSync } from 'child_process'
import { createHash, createDecipheriv } from 'crypto'
import os from 'os'

const LICENSE_SECRET = 'NocVault-License-Secret-2026-X9K' // 32 chars
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

export function getServerId(): string {
  const machineGuid = getMachineGuid()
  const hostname = os.hostname()
  const raw = `${hostname}-${machineGuid}`
  const hash = createHash('sha256').update(raw).digest('hex').substring(0, 32)
  return `NCV-${hash}`
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
