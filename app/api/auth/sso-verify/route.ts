import { NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
import { query } from '@/lib/db'
import bcrypt from 'bcryptjs'

export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json()
    if (!token) return NextResponse.json({ error: 'Token required' }, { status: 400 })

    const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET!) as {
      userId: string; email: string; role: string; name: string; app: string
    }

    // Verify user still exists
    const result = await query('SELECT id, email, role FROM users WHERE email = $1', [decoded.email])
    if (!result.rows.length) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const user = result.rows[0]

    return NextResponse.json({
      email: user.email,
      role: user.role,
      name: decoded.name,
      userId: user.id,
    })
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return NextResponse.json({ error: 'Token expired' }, { status: 401 })
    }
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }
}
