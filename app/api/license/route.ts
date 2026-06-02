import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { getServerId, validateLicenseKey, getLicenseStatus } from '@/lib/license'

export async function checkWriteAllowed(): Promise<NextResponse | null> {
  try {
    const result = await query(
      "SELECT key, value FROM app_settings WHERE key IN ('install_date','license_key')"
    )
    const s: Record<string, string> = {}
    for (const row of result.rows) s[row.key] = row.value ?? ''
    const serverId = getServerId()
    const { status } = getLicenseStatus(s['install_date'] ?? '', s['license_key'] ?? '', serverId)
    if (status === 'expired') {
      return NextResponse.json(
        { error: 'License expired. Please activate a license key to continue.' },
        { status: 403 }
      )
    }
    return null
  } catch {
    return null
  }
}

export async function GET() {
  try {
    const serverId = getServerId()

    const result = await query(
      "SELECT key, value FROM app_settings WHERE key IN ('install_date','license_key')"
    )
    const s: Record<string, string> = {}
    for (const row of result.rows) s[row.key] = row.value ?? ''

    const installDate = s['install_date'] ?? ''
    const licenseKey  = s['license_key']  ?? ''

    const { status, daysRemaining, payload } = getLicenseStatus(installDate, licenseKey, serverId)

    return NextResponse.json({
      status,
      daysRemaining,
      serverId,
      customer:    payload?.customer    ?? null,
      expiry:      payload?.expiry      ?? null,
      modules:     payload?.modules     ?? [],
      maxDevices:  payload?.maxDevices  ?? null,
      trialDaysTotal: 30,
      installDate: installDate || null,
    })
  } catch (err) {
    console.error('[license GET]', err)
    return NextResponse.json({ error: 'Failed to get license status' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const user = session.user as { role?: string }
    if (user?.role !== 'super_admin') {
      return NextResponse.json({ error: 'Only super admins can activate licenses' }, { status: 403 })
    }

    const body = await req.json()
    const key: string = body?.key ?? ''
    if (!key.trim()) return NextResponse.json({ error: 'License key is required' }, { status: 400 })

    const serverId = getServerId()
    const result = validateLicenseKey(key, serverId)

    if (!result.valid) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    // Store the key
    await query(
      "INSERT INTO app_settings (key, value) VALUES ('license_key', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [key.trim()]
    )

    return NextResponse.json({
      success:  true,
      customer: result.payload!.customer,
      expiry:   result.payload!.expiry,
      modules:  result.payload!.modules,
    })
  } catch (err) {
    console.error('[license POST]', err)
    return NextResponse.json({ error: 'Failed to activate license' }, { status: 500 })
  }
}
