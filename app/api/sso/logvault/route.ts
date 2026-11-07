//
// app/api/sso/logvault/route.ts — the hub's signed handoff to LogVault.
//
// ⛔ `getServerSession`, NEVER `getToken`. `getToken()` only DECODES the cookie;
// it runs no callbacks, so the mid-session revocation layer in
// `[...nextauth]`'s `jwt` callback — the one whose own header says "a mapping an
// administrator revokes must stop working at once" — does not run at all. This
// route always used `getServerSession`; its ddivault and spanvault siblings did
// not, and were handed the old mapped role for the whole life of the JWT. All
// three now take the same path (1.63.0).
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
  // ⛔ A SESSION WITH NO ROLE IS NOT A SESSION FOR THIS PURPOSE. The jwt
  // callback clears the role on a revoked mapping or a deleted account, and
  // carrying on from there would mint a satellite token with `role: null` —
  // which SpanVault reads as `'viewer'`. Treated exactly like no session at
  // all: sign in again, and the front door decides.
  const user = session ? handoffIdentity(session.user) : null
  if (!user) {
    return NextResponse.redirect(new URL('/login?callbackUrl=%2Fapi%2Fsso%2Flogvault', ownOrigin))
  }

  const apps = await getUserApps(user.id, user.role)
  if (!canAccessApp(apps, 'logvault')) {
    return NextResponse.redirect(`${ownOrigin}/launcher?denied=logvault`)
  }

  const token = jwt.sign(
    ssoClaims(user, 'logvault', apps),
    process.env.NEXTAUTH_SECRET!,
    { expiresIn: SSO_TOKEN_TTL }
  )

  const lvUrl = resolveOrigin(
    req,
    SIBLING_PORTS.logvault,
    (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(':3000', ':3004')
  )
  return NextResponse.redirect(`${lvUrl}/sso?token=${token}`)
}
