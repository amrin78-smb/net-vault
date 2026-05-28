import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import jwt from 'jsonwebtoken'

export async function GET(req: NextRequest) {
  console.log('[SSO DDIVault] Request received')
  console.log('[SSO DDIVault] Cookie header:', req.headers.get('cookie')?.substring(0, 100))
  
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  console.log('[SSO DDIVault] Token found:', !!token, token?.email)
  
  if (!token) {
    console.log('[SSO DDIVault] No token - redirecting to login')
    return NextResponse.redirect(`${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/login?callbackUrl=%2Fapi%2Fsso%2Fddivault`)
  }

  const ssoToken = jwt.sign(
    {
      userId: token.id,
      email: token.email,
      role: token.role,
      name: token.name,
      app: 'ddivault',
    },
    process.env.NEXTAUTH_SECRET!,
    { expiresIn: '2m' }
  )

  console.log('[SSO DDIVault] Generated token for:', token.email, '- redirecting to DDIVault')
  const ddiUrl = (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(':3000', ':3006')
  return NextResponse.redirect(`${ddiUrl}/sso?token=${ssoToken}`)
}
