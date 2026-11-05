import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { DIRECTORY_REFUSAL_KEEP, explainRefusal, listDirectoryRefusals } from '@/lib/directoryRefusals.ts'

export const dynamic = 'force-dynamic'

// Settings → Single sign-on → recent refused sign-ins.
//
// ⛔ super_admin ONLY, LIKE ITS TWO SIBLINGS. This answers "who tried to sign
// in, when, and which directory groups were they in" — an account inventory of
// the customer's directory, assembled from tokens. It is also the diagnostic
// for the mapping table, which is super_admin, so anything weaker would be a
// way to read out the inputs to a decision you are not allowed to make.
//
// ⛔ READ-ONLY, AND THERE IS NO DELETE. The table is capped by its writer
// (DIRECTORY_REFUSAL_KEEP), so it cannot grow without bound; offering a "clear"
// button would let whoever is causing refusals erase the evidence of them, and
// the only reason to want one — it is getting long — is already handled.

type SessionUser = { role?: string }

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (((session as { user?: SessionUser }).user || {}).role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const rows = await listDirectoryRefusals()
    return NextResponse.json({
      // Travels as data: a client component cannot import this constant without
      // pulling the pg driver into the browser bundle.
      keep: DIRECTORY_REFUSAL_KEEP,
      refusals: rows.map((r) => ({
        id: String(r.id),
        occurredAt: r.occurred_at,
        email: r.email,
        entraOid: r.entra_oid,
        // The raw cause is NOT returned. It carries a free-text reason built
        // server-side, and everything an administrator needs from it is in the
        // explanation — which is derived from the code alone, so no detail
        // written for a log can leak into a page by accident.
        explanation: explainRefusal(r.cause),
        groupKeys: Array.isArray(r.group_keys) ? r.group_keys : [],
      })),
    })
  } catch (err) {
    // ⛔ A FAILED READ IS NOT "NOTHING HAS BEEN REFUSED". That is the answer an
    // administrator acts on by concluding sign-in works.
    console.error('[directory-refusals] list failed:', err)
    return NextResponse.json(
      { error: 'Could not read the refused sign-ins. This is a database fault — it does not mean nobody has been refused.' },
      { status: 500 },
    )
  }
}
