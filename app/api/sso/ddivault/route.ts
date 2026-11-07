//
// app/api/sso/ddivault/route.ts — the hub's signed handoff to DDIVault.
//
// ⛔ `getServerSession`, NEVER `getToken` — CHANGED IN 1.63.0 AND THIS WAS A
// REAL HOLE. `getToken({ req, secret })` decodes the session cookie and runs NO
// callbacks, so `[...nextauth]`'s `jwt` callback never ran on this path — and
// that callback IS the mid-session revocation layer. A directory user whose
// group→role mapping an administrator had revoked was refused by the logvault
// handoff (which always used `getServerSession`) and handed a satellite token
// carrying the OLD mapped role by this one, for the whole life of the JWT. Same
// defect in the spanvault sibling; all three now share the one path.
//
// ⛔ THE CLAIM NAMES ARE A CONTRACT WITH ANOTHER REPOSITORY, so they are built
// by `lib/ssoHandoff.ts` rather than spelled out here. See that file.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { getUserApps, canAccessApp } from '@/lib/appAccess'
import { resolveOrigin, SIBLING_PORTS } from '@/lib/publicUrl'
import { handoffIdentity, ssoClaims, SSO_TOKEN_TTL } from '@/lib/ssoHandoff.ts'
import jwt from 'jsonwebtoken'

export async function GET(req: NextRequest) {
  const ownOrigin = resolveOrigin(req, null, process.env.NEXTAUTH_URL || 'http://localhost:3000')

  const session = await getServerSession(authOptions)
  // ⛔ A SESSION WITH NO ROLE IS NOT A SESSION FOR THIS PURPOSE — see the
  // logvault sibling. The jwt callback clears the role on a revoked mapping or
  // a deleted account; carrying on would mint a token with `role: null`.
  const user = session ? handoffIdentity(session.user) : null
  if (!user) {
    return NextResponse.redirect(`${ownOrigin}/login?callbackUrl=%2Fapi%2Fsso%2Fddivault`)
  }

  const apps = await getUserApps(user.id, user.role)
  if (!canAccessApp(apps, 'ddivault')) {
    // ⛔ NO IDENTIFIER IN THE LOG LINE. This used to print the email of every
    // denied user on every attempt; the refusal is the event worth recording
    // and the audit trail is where a subject belongs.
    console.log('[SSO DDIVault] Access denied')
    return NextResponse.redirect(`${ownOrigin}/launcher?denied=ddivault`)
  }

  const ssoToken = jwt.sign(
    ssoClaims(user, 'ddivault', apps),
    process.env.NEXTAUTH_SECRET!,
    { expiresIn: SSO_TOKEN_TTL }
  )

  const ddiUrl = resolveOrigin(
    req,
    SIBLING_PORTS.ddivault,
    (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(':3000', ':3006')
  )
  return NextResponse.redirect(`${ddiUrl}/sso?token=${ssoToken}`)
}
