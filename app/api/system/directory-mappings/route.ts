import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import {
  createDirectoryMapping,
  deleteDirectoryMapping,
  listDirectoryMappings,
  type DirectoryMappingRow,
} from '@/lib/directoryStore.ts'
import { DIRECTORY_PROVISIONABLE_ROLES, type Role } from '@/lib/directoryUser.ts'
import { recordSystemChanges } from '@/lib/systemAudit.ts'

export const dynamic = 'force-dynamic'

// Settings → Single sign-on → group mappings. The group -> role table that
// decides what a directory identity becomes.
//
// ⛔ super_admin ONLY, FOR THE REASON /api/system/entra's HEADER ALREADY NAMES.
// That file explains the escalation it is guarding against as: an `admin` who
// could "point ENTRA_TENANT_ID at a tenant they control, MAP A GROUP THEY OWN
// TO super_admin and sign in". This route is the second half of that sentence.
// Gating the tenant on super_admin and the mappings on `admin` would leave the
// escalation intact on a box whose tenant is already set — an admin maps a
// group they control in the trusted tenant to super_admin, signs in, and has
// passed every other check in this product. There is no weaker gate that works.
//
// ⛔ WITHOUT A ROW HERE, NOBODY CAN SIGN IN WITH A DIRECTORY ACCOUNT, AND THAT
// IS CORRECT. lib/directoryRoles.ts returns OUTCOME.NO_MAPPINGS for an empty
// table and refuses everyone. An empty table is the shipping state, so "SSO is
// configured but nobody can get in" is the expected first experience and the
// panel says so. Do not add a default mapping to make it feel finished: a
// default would grant a role to a group somebody else controls.

type SessionUser = { id?: number | string; role?: string }

function roleOf(session: unknown): string | undefined {
  return ((session as { user?: SessionUser } | null)?.user || {}).role
}
function actorOf(session: unknown): number | string | null | undefined {
  return ((session as { user?: SessionUser } | null)?.user || {}).id
}

async function guard(): Promise<
  { ok: true; session: unknown } | { ok: false; res: NextResponse }
> {
  const session = await getServerSession(authOptions)
  if (!session) {
    return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (roleOf(session) !== 'super_admin') {
    return { ok: false, res: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { ok: true, session }
}

/** The shape the panel renders. `group_key` is the GUID it matches on. */
function toPublic(row: DirectoryMappingRow) {
  return {
    id: row.id,
    groupKey: row.group_key,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  }
}

export async function GET() {
  const g = await guard()
  if (!g.ok) return g.res
  try {
    const rows = await listDirectoryMappings()
    return NextResponse.json({
      mappings: rows.map(toPublic),
      roles: DIRECTORY_PROVISIONABLE_ROLES,
    })
  } catch (err) {
    // ⛔ NEVER ANSWER A FAILED READ WITH AN EMPTY LIST. `mappings: []` is the
    // state "no group is mapped, so every directory sign-in is refused" — a
    // real, correct configuration. Reporting a database fault as that state
    // would tell an administrator to go and add mappings they already have, and
    // the obvious next move (adding them again) hits the duplicate path.
    console.error('[directory-mappings] list failed:', err)
    return NextResponse.json(
      { error: 'Could not read the group mappings. This is a database fault, not a configuration problem — your existing mappings are unaffected.' },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  const g = await guard()
  if (!g.ok) return g.res

  let body: { groupKey?: unknown; displayName?: unknown; role?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const groupKey = typeof body.groupKey === 'string' ? body.groupKey.trim() : ''
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  const role = typeof body.role === 'string' ? body.role.trim() : ''

  if (!groupKey) {
    return NextResponse.json(
      { error: 'Enter the group’s object ID — the GUID Entra puts in the token’s groups claim.' },
      { status: 400 },
    )
  }
  // ⛔ VALIDATED HERE, NOT LEFT TO THE CHECK CONSTRAINT. The table carries
  // `directory_role_mappings_role_check` as a second line of defence, but a
  // constraint violation arrives as a Postgres error string and a 500 — so the
  // administrator who picked a role this product will not provision would be
  // shown a database message instead of the reason. site_admin is the live case:
  // it is excluded from DIRECTORY_PROVISIONABLE_ROLES because a site_admin
  // provisioned from the directory would have no `user_sites` rows and so could
  // see nothing at all.
  if (!(DIRECTORY_PROVISIONABLE_ROLES as string[]).includes(role)) {
    return NextResponse.json(
      {
        error: `“${role || '(none)'}” cannot be granted from a directory group. Choose one of: ${DIRECTORY_PROVISIONABLE_ROLES.join(', ')}.`,
        detail:
          role === 'site_admin'
            ? 'A site_admin is scoped to assigned sites, and an account provisioned from the directory has none — it would sign in able to see nothing. Assign site_admin to a local account, or to a directory account after it first signs in.'
            : undefined,
      },
      { status: 400 },
    )
  }

  try {
    const row = await createDirectoryMapping({
      groupKey,
      displayName: displayName || null,
      role: role as Role,
    })
    if (!row) {
      // Distinct from the 500 below, and deliberately so — see
      // createDirectoryMapping's contract.
      return NextResponse.json(
        {
          error: 'That group is already mapped. Remove the existing mapping first if you want to change the role it grants.',
          duplicate: true,
        },
        { status: 409 },
      )
    }
    await recordSystemChanges(
      actorOf(g.session),
      [{ key: row.group_key, from: null, to: row.role }],
      'directory_mapping',
    )
    return NextResponse.json({ mapping: toPublic(row) }, { status: 201 })
  } catch (err) {
    console.error('[directory-mappings] create failed:', err)
    return NextResponse.json({ error: 'Could not save the mapping.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const g = await guard()
  if (!g.ok) return g.res

  // Read the id from the query string: a DELETE body is legal but awkward for
  // caches and proxies, and this is a single scalar.
  const raw = new URL(req.url).searchParams.get('id')
  const id = raw === null ? NaN : Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'A numeric mapping id is required.' }, { status: 400 })
  }

  try {
    const row = await deleteDirectoryMapping(id)
    if (!row) {
      return NextResponse.json({ error: 'That mapping no longer exists.' }, { status: 404 })
    }
    await recordSystemChanges(
      actorOf(g.session),
      [{ key: row.group_key, from: row.role, to: null }],
      'directory_mapping',
    )
    // ⛔ SAY WHAT REMOVING THE LAST ONE DID. An empty table refuses every
    // directory sign-in, and an administrator tidying up a list has no reason
    // to know that deleting the final row locks the whole directory out.
    let remaining = -1
    try {
      remaining = (await listDirectoryMappings()).length
    } catch {
      // The delete succeeded; a failed count must not turn it into an error.
    }
    return NextResponse.json({
      removed: toPublic(row),
      remaining,
      lockedOut: remaining === 0,
    })
  } catch (err) {
    console.error('[directory-mappings] delete failed:', err)
    return NextResponse.json({ error: 'Could not remove the mapping.' }, { status: 500 })
  }
}
