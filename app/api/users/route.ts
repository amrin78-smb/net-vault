import { NextResponse, NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { ALL_APPS } from '@/lib/appAccess'
import { findUserByEmail } from '@/lib/directoryStore'
import { decideLocalAccountEmail } from '@/lib/localAccountPolicy'

// ⛔ NO `checkWriteAllowed` IN THIS FILE, DELIBERATELY. REMOVED 1.65.5 — DO NOT
// ADD IT BACK.
//
// The licence gate exists to stop an unlicensed install producing product
// VALUE: devices, sites, circuits, imports, agent enrolment. Those routes all
// call it and should. User management is not that, for three reasons:
//
//  1. IT ENFORCES NO LICENCE TERM. `LicensePayload` carries `modules` and
//     `maxDevices` and nothing else — there is no seat or user limit anywhere
//     in this codebase. Gating users restricted something the licence never
//     sold, so the block bought nothing.
//  2. NETVAULT IS THE HUB. `users` is suite-wide identity: LogVault, DDIVault
//     and SpanVault all authenticate against this table. A NetVault licence
//     lapsing took user management away from the whole suite, which the
//     expiry banner never said and nobody would predict.
//  3. ⛔ IT BLOCKED THE TWO RECOVERY PATHS THAT MUST NEVER BE BLOCKED —
//     adding an administrator to get the installation working again, and
//     DELETING A COMPROMISED ACCOUNT. A lapsed licence must never be the
//     reason someone keeps access they should have lost. That is a commercial
//     dispute turning into a security incident.
//
// The rest of hub administration — settings, Entra/SSO, the certificate, the
// transport, the suite mail server — is ungated for the same reason and always
// was; `users` was the lone outlier. `tests/systemSeams.test.ts` asserts this
// split in BOTH directions, so adding the gate here fails the suite.

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const res = await query(`
    SELECT u.id, u.name, u.email, u.role, u.auth_provider, u.created_at,
      COALESCE(
        json_agg(json_build_object('id', s.id, 'name', s.name, 'code', s.code))
        FILTER (WHERE s.id IS NOT NULL), '[]'
      ) as sites,
      COALESCE(
        (SELECT json_agg(ua.app) FROM user_apps ua WHERE ua.user_id = u.id), '[]'
      ) as apps
    FROM users u
    LEFT JOIN user_sites us ON us.user_id = u.id
    LEFT JOIN sites s ON s.id = us.site_id
    GROUP BY u.id ORDER BY u.created_at
  `)
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = await req.json()
  if (!body.name || !body.email || !body.password)
    return NextResponse.json({ error: 'Name, email and password required' }, { status: 400 })
  // ⛔ ONE POLICY, ONE FUNCTION, EVERY WRITE PATH — lib/localAccountPolicy.ts.
  // This replaces a bare `SELECT id FROM users WHERE email = $1` + "Email
  // already exists", which was wrong in two ways: it was CASE-SENSITIVE (so
  // `A@x` and `a@x` were both insertable, and the directory half's
  // case-insensitive lookup would then find a collision nobody could see
  // coming), and it could not say that the address belongs to the DIRECTORY —
  // the one duplicate whose fix is "this person signs in with Entra", not
  // "pick another address". The sibling edit path uses the same call.
  const emailHolder = await findUserByEmail(body.email)
  const emailDecision = decideLocalAccountEmail(body.email, emailHolder)
  if (!emailDecision.allowed)
    return NextResponse.json(
      { error: emailDecision.reason, field: emailDecision.field },
      { status: emailDecision.status },
    )
  const hash = await bcrypt.hash(body.password, 10)
  const res = await query(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
    [body.name, body.email, hash, body.role || 'viewer']
  )
  const userId = res.rows[0].id
  if (body.site_ids?.length > 0) {
    for (const siteId of body.site_ids) {
      await query('INSERT INTO user_sites (user_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, siteId])
    }
  }
  // App access: only write explicit rows when app_slugs is a non-empty array
  // (absent/empty → no rows → default-all). netvault is always accessible.
  if (Array.isArray(body.app_slugs) && body.app_slugs.length > 0) {
    const slugs = new Set<string>(body.app_slugs.filter((s: unknown) => (ALL_APPS as readonly string[]).includes(s as string)) as string[])
    slugs.add('netvault')
    for (const app of slugs) {
      await query('INSERT INTO user_apps (user_id, app) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, app])
    }
  }
  return NextResponse.json({ id: userId }, { status: 201 })
}
