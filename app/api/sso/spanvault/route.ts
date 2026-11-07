//
// app/api/sso/spanvault/route.ts — the hub's signed handoff to SpanVault.
//
// ⛔ `getServerSession`, NEVER `getToken` — CHANGED IN 1.63.0 AND THIS WAS A
// REAL HOLE. `getToken({ req, secret })` decodes the session cookie and runs NO
// callbacks, so `[...nextauth]`'s `jwt` callback — the mid-session revocation
// layer — never ran on this path. A directory user whose group→role mapping an
// administrator had revoked was refused by the logvault handoff and handed a
// token carrying the OLD mapped role by this one. Same defect in the ddivault
// sibling; all three now share the one path.
//
// ⛔ SPANVAULT REQUIRES `userId` AND `app === 'spanvault'` IN THE PAYLOAD
// (spanvault/frontend/src/lib/auth.ts). Dropping or renaming either claim
// breaks SpanVault sign-in entirely and nothing in THIS repository fails, which
// is why the claim set is built by `lib/ssoHandoff.ts` and asserted by name.

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
  // ⛔ A SESSION WITH NO ROLE IS NOT A SESSION FOR THIS PURPOSE, AND SPANVAULT
  // IS THE WORST PLACE TO LET ONE THROUGH: its `authorize()` falls back to
  // `payload.role || 'viewer'`, so a revoked directory super_admin would arrive
  // as a working viewer rather than being refused.
  const user = session ? handoffIdentity(session.user) : null
  if (!user) {
    return NextResponse.redirect(`${ownOrigin}/login?callbackUrl=%2Fapi%2Fsso%2Fspanvault`)
  }

  const apps = await getUserApps(user.id, user.role)
  if (!canAccessApp(apps, 'spanvault')) {
    return NextResponse.redirect(`${ownOrigin}/launcher?denied=spanvault`)
  }

  const ssoToken = jwt.sign(
    ssoClaims(user, 'spanvault', apps),
    process.env.NEXTAUTH_SECRET!,
    { expiresIn: SSO_TOKEN_TTL }
  )

  const svUrl = resolveOrigin(
    req,
    SIBLING_PORTS.spanvault,
    (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(':3000', ':3008')
  )
  return NextResponse.redirect(`${svUrl}/sso?token=${ssoToken}`)
}
