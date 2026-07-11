import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { getUserApps, canAccessApp } from '@/lib/appAccess'
import { resolveOrigin, SIBLING_PORTS } from '@/lib/publicUrl'
import jwt from 'jsonwebtoken'

export async function GET(req: NextRequest) {
  const ownOrigin = resolveOrigin(req, null, process.env.NEXTAUTH_URL || 'http://localhost:3000')
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })

  if (!token) {
    return NextResponse.redirect(`${ownOrigin}/login?callbackUrl=%2Fapi%2Fsso%2Fspanvault`)
  }

  const apps = await getUserApps(token.id as string | number, token.role as string)
  if (!canAccessApp(apps, 'spanvault')) {
    return NextResponse.redirect(`${ownOrigin}/launcher?denied=spanvault`)
  }

  const ssoToken = jwt.sign(
    {
      userId: token.id,
      email: token.email,
      role: token.role,
      name: token.name,
      app: 'spanvault',
      apps,
    },
    process.env.NEXTAUTH_SECRET!,
    { expiresIn: '2m' }
  )

  const svUrl = resolveOrigin(
    req,
    SIBLING_PORTS.spanvault,
    (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(':3000', ':3008')
  )
  return NextResponse.redirect(`${svUrl}/sso?token=${ssoToken}`)
}
