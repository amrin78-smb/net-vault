import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { calcTechnicalDebt } from '@/lib/techDebt'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const res = await query('SELECT * FROM v_devices_flat WHERE id = $1', [id])
  if (!res.rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(res.rows[0])
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string; id: string; siteIds?: number[] }
  if (user.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const body = await req.json()
  const old = await query('SELECT * FROM v_devices_flat WHERE id = $1', [id])
  if (user.role === 'site_admin') {
    if (!user.siteIds?.includes(old.rows[0]?.site_id)) {
      return NextResponse.json({ error: 'You can only edit devices at your assigned sites' }, { status: 403 })
    }
  }
  await query(`
    UPDATE devices SET
      name=$1,brand_id=(SELECT id FROM brands WHERE name=$2),
      model=$3,serial_number=$4,
      device_type_id=(SELECT id FROM device_types WHERE name=$5),
      ip_address=$6,mgmt_protocol=$7,mgmt_url=$8,
      site_id=(SELECT id FROM sites WHERE name=$9),
      location_detail=$10,lifecycle_status=$11,device_status=$12,
      risk_score=$13,technical_debt=$14,remark=$15,cost=$16,
      purchase_date=$17,
      purchase_vendor_id=(SELECT id FROM vendors WHERE name=$18),
      ma_vendor_id=(SELECT id FROM vendors WHERE name=$19),
      updated_by=$20
    WHERE id=$21`,
    [body.name,body.brand,body.model,body.serial_number,body.device_type,
     body.ip_address||null,body.mgmt_protocol||null,body.mgmt_url||null,
     body.site,body.location_detail||null,body.lifecycle_status,body.device_status,
     body.risk_score||null,calcTechnicalDebt(body.lifecycle_status,body.device_status,body.device_type),body.remark||null,
     body.cost||null,body.purchase_date||null,
     body.purchase_vendor||null,body.ma_vendor||null,
     parseInt(user.id),id])
  await query(
    `INSERT INTO audit_log (device_id, changed_by, field_name, old_value, new_value) VALUES ($1,$2,'updated',$3,$4)`,
    [id, parseInt(user.id), JSON.stringify(old.rows[0]), JSON.stringify(body)])
  return NextResponse.json({ success: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string; id: string }
  if (user.role !== 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const old = await query('SELECT * FROM v_devices_flat WHERE id = $1', [id])
  await query(
    `INSERT INTO audit_log (device_id, changed_by, field_name, old_value, new_value) VALUES ($1,$2,'deleted',$3,NULL)`,
    [id, parseInt(user.id), JSON.stringify(old.rows[0])])
  await query('DELETE FROM devices WHERE id = $1', [id])
  return NextResponse.json({ success: true })
}
