import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

const ADMIN_ALLOWED_KEYS = new Set(['idle_timeout_minutes'])

// Sensitive keys that must never be exposed to non-admin callers
const SENSITIVE_KEYS = new Set(['license_key'])

export async function GET() {
  const session = await getServerSession(authOptions)
  const role = (session?.user as { role?: string } | undefined)?.role
  const isAdmin = role === 'admin' || role === 'super_admin'

  const res = await query('SELECT key, value FROM app_settings')
  const settings: Record<string, string> = {}
  res.rows.forEach(r => {
    // Redact sensitive keys (e.g. license_key) for non-admin callers so the
    // login/launcher pages can still fetch public branding unauthenticated.
    if (!isAdmin && SENSITIVE_KEYS.has(r.key)) return
    settings[r.key] = r.value
  })
  return NextResponse.json(settings)
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  const isSuperAdmin = user.role === 'super_admin'
  const isAdmin = user.role === 'admin' || user.role === 'super_admin'

  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()

  if (!isSuperAdmin) {
    const disallowed = Object.keys(body).filter(k => !ADMIN_ALLOWED_KEYS.has(k))
    if (disallowed.length > 0) {
      return NextResponse.json({ error: 'Only super admins can change branding' }, { status: 403 })
    }
  }

  for (const [key, value] of Object.entries(body)) {
    await query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value]
    )
  }
  return NextResponse.json({ success: true })
}
