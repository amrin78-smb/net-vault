import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { getUserApps, canAccessApp } from '@/lib/appAccess'
import { resolveOrigin, SIBLING_PORTS } from '@/lib/publicUrl'
import jwt from 'jsonwebtoken'

export async function GET(req: NextRequest) {
  const ownOrigin = resolveOrigin(req, null, process.env.NEXTAUTH_URL || 'http://localhost:3000')

  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.redirect(new URL('/login?callbackUrl=%2Fapi%2Fsso%2Flogvault', ownOrigin))
  }

  const user = session.user as { id: string; email: string; role: string; name: string }

  const apps = await getUserApps(user.id, user.role)
  if (!canAccessApp(apps, 'logvault')) {
    return NextResponse.redirect(`${ownOrigin}/launcher?denied=logvault`)
  }

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      app: 'logvault',
      apps,
    },
    process.env.NEXTAUTH_SECRET!,
    { expiresIn: '2m' }
  )

  const lvUrl = resolveOrigin(
    req,
    SIBLING_PORTS.logvault,
    (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(':3000', ':3004')
  )
  return NextResponse.redirect(`${lvUrl}/sso?token=${token}`)
}
