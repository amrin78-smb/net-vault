import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { ALL_APPS } from '@/lib/appAccess'
import { findUserByEmail } from '@/lib/directoryStore'
import { decideLocalAccountEmail, decideDirectoryAccountEdit } from '@/lib/localAccountPolicy'

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

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sessionUser = session.user as { role: string }
  if (sessionUser.role !== 'admin' && sessionUser.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const body = await req.json()

  // Regular admins cannot edit super_admin accounts or assign super_admin role.
  // `auth_provider` and `email` come back too, for the directory-account guard
  // below — one SELECT rather than two, since this row is needed either way.
  const targetUser = await query('SELECT role, email, auth_provider FROM users WHERE id=$1', [id])
  if (targetUser.rows[0]?.role === 'super_admin' && sessionUser.role !== 'super_admin')
    return NextResponse.json({ error: 'Only super admins can edit super admin accounts' }, { status: 403 })
  if (body.role === 'super_admin' && sessionUser.role !== 'super_admin')
    return NextResponse.json({ error: 'Only super admins can assign the super admin role' }, { status: 403 })

  // ⛔ THE SAME GUARD AS THE CREATE PATH, FROM THE SAME FUNCTION — and it runs
  // on the edit path for the same reason it runs on create: this UPDATE writes
  // `email` from the request body, so without it an administrator can rename a
  // local account onto a directory address and the refusal surfaces later, to
  // the directory user, as a failed sign-in. See lib/localAccountPolicy.ts.
  //
  // ⛔ `id` IS PASSED, AND IT IS WHAT KEEPS THIS PATH WORKING AT ALL. Every edit
  // that does not change the email finds its OWN row by that email — including a
  // directory account's own record. An email resolving to the SAME row id is not
  // a collision.
  // ⛔ A DIRECTORY ACCOUNT MAY NOT BE GIVEN A LOCAL PASSWORD HERE, and that is
  // the guard that matters most on this route: the UPDATE below writes
  // `password_hash` from the body with no regard for whose row it is, nothing in
  // the schema forbids a hash on an `entra` row, and the moment one exists
  // `canUsePassword()` returns true — a local credential path for an identity
  // whose credentials belong to the customer's directory.
  //
  // Its role and address are refused for different reasons (silently overwritten
  // at the next sign-in; divergence or lockout) — see lib/localAccountPolicy.ts.
  // `name`, `site_ids` and `app_slugs` still go through, because user_apps and
  // user_sites are hub-owned data the directory cannot supply and this route is
  // the only way to set them.
  const editDecision = decideDirectoryAccountEdit(targetUser.rows[0], body)
  if (!editDecision.allowed)
    return NextResponse.json(
      { error: editDecision.reason, field: editDecision.field },
      { status: editDecision.status },
    )

  const candidateEmail = typeof body.email === 'string' ? body.email.trim() : ''
  const emailHolder = candidateEmail ? await findUserByEmail(candidateEmail) : null
  const emailDecision = decideLocalAccountEmail(body.email, emailHolder, id)
  if (!emailDecision.allowed)
    return NextResponse.json(
      { error: emailDecision.reason, field: emailDecision.field },
      { status: emailDecision.status },
    )

  if (body.password) {
    const hash = await bcrypt.hash(body.password, 10)
    await query('UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4 WHERE id=$5',
      [body.name, body.email, body.role, hash, id])
  } else {
    await query('UPDATE users SET name=$1, email=$2, role=$3 WHERE id=$4',
      [body.name, body.email, body.role, id])
  }
  // Update site assignments
  await query('DELETE FROM user_sites WHERE user_id=$1', [id])
  if (body.site_ids?.length > 0) {
    for (const siteId of body.site_ids) {
      await query('INSERT INTO user_sites (user_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [parseInt(id), siteId])
    }
  }
  // Rewrite explicit app access. No app_slugs → no rows → default-all.
  // netvault is always accessible.
  await query('DELETE FROM user_apps WHERE user_id=$1', [id])
  if (body.app_slugs?.length) {
    const slugs = new Set<string>(body.app_slugs.filter((s: unknown) => (ALL_APPS as readonly string[]).includes(s as string)) as string[])
    slugs.add('netvault')
    for (const app of slugs) {
      await query('INSERT INTO user_apps (user_id, app) VALUES ($1,$2) ON CONFLICT DO NOTHING', [parseInt(id), app])
    }
  }
  return NextResponse.json({ success: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Only super admins can delete users' }, { status: 403 })
  const { id } = await params

  // ⛔ THE LAST SUPER ADMIN CANNOT BE DELETED. Only super_admin can manage
  // users or the licence, so losing the last one leaves an installation nobody
  // can ever administer again — recoverable only by editing the database by
  // hand. Counted, not assumed: the guard asks how many super_admins remain,
  // because "am I deleting myself" is a different and weaker question (deleting
  // the OTHER super_admin when you are the only two is fine; deleting the only
  // one is not, whoever is signed in).
  const target = await query('SELECT role FROM users WHERE id=$1', [id])
  if (!target.rows[0]) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.rows[0].role === 'super_admin') {
    const remaining = await query("SELECT count(*)::int AS n FROM users WHERE role = 'super_admin'")
    if ((remaining.rows[0]?.n ?? 0) <= 1) {
      return NextResponse.json(
        {
          error:
            'This is the only super admin account. Deleting it would leave nobody able to manage ' +
            'users or the licence. Create another super admin first.',
        },
        { status: 409 },
      )
    }
  }

  try {
    await query('DELETE FROM users WHERE id=$1', [id])
  } catch (err: unknown) {
    // ⛔ A FOREIGN-KEY VIOLATION IS A 409 WITH A CAUSE, NOT AN UNCAUGHT 500.
    // This route had no catch at all, so a blocking reference surfaced as a
    // generic server error and the Users page rendered "Failed to delete user".
    // Measured on the live database: three FKs into `users` were ON DELETE NO
    // ACTION, and the oldest account was referenced by 2,482 devices — so the
    // only accounts that could be deleted were ones that had never done
    // anything. schema.sql now converts those three to SET NULL, and this
    // branch is what reports any FK we have not converted, by name, instead of
    // hiding it.
    const code = (err as { code?: string } | null)?.code
    if (code === '23503') {
      const detail = (err as { detail?: string }).detail || ''
      const table = /table "([^"]+)"/.exec(detail)?.[1]
      return NextResponse.json(
        {
          error:
            'This account cannot be deleted because other records still refer to it' +
            (table ? ` (in ${table})` : '') +
            '. It can be left in place with the viewer role instead.',
        },
        { status: 409 },
      )
    }
    throw err
  }
  return NextResponse.json({ success: true })
}
