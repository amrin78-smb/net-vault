import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { checkWriteAllowed } from '@/app/api/license/route'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string; siteIds?: number[] }
  const { id } = await params
  const res = await query(`
    SELECT c.*, s.name as site, s.code as site_code,
           co.name as country, r.name as region
    FROM circuits c
    LEFT JOIN sites s ON s.id = c.site_id
    LEFT JOIN countries co ON co.id = s.country_id
    LEFT JOIN regions r ON r.id = co.region_id
    WHERE c.id = $1
  `, [id])
  if (!res.rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (user.role === 'site_admin' && !user.siteIds?.includes(res.rows[0].site_id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(res.rows[0])
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const writeBlock = await checkWriteAllowed(); if (writeBlock) return writeBlock
  const user = session.user as { role: string }
  if (user.role !== 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const body = await req.json()
  await query(`
    UPDATE circuits SET
      isp=$1, usage=$2, circuit_id=$3, product=$4, technology=$5,
      circuit_type=$6, interface=$7, max_speed=$8, guaranteed_speed=$9,
      public_subnet=$10, currency=$11, cost_month=$12, contract_term=$13,
      comment=$14, pingable=$15, updated_at=NOW()
    WHERE id=$16
  `, [
    body.isp, body.usage, body.circuit_id, body.product, body.technology,
    body.circuit_type, body.interface, body.max_speed, body.guaranteed_speed,
    body.public_subnet, body.currency || 'THB', body.cost_month || null,
    body.contract_term, body.comment, body.pingable, id
  ])
  return NextResponse.json({ success: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const writeBlock = await checkWriteAllowed(); if (writeBlock) return writeBlock
  const user = session.user as { role: string }
  if (user.role !== 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  await query('DELETE FROM circuits WHERE id = $1', [id])
  return NextResponse.json({ success: true })
}
