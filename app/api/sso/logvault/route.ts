import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import jwt from 'jsonwebtoken'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  const user = session.user as { id: string; email: string; role: string; name: string }

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      app: 'logvault',
    },
    process.env.NEXTAUTH_SECRET!,
    { expiresIn: '2m' }
  )

  return NextResponse.redirect(`http://192.168.6.111:3004/sso?token=${token}`)
}
