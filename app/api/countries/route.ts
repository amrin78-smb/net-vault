import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const res = await query(`
    SELECT c.id, c.name, c.iso_code, r.name as region
    FROM countries c
    JOIN regions r ON r.id = c.region_id
    ORDER BY r.name, c.name
  `)
  return NextResponse.json(res.rows)
}
