import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

function normaliseType(t: string) {
  const map: Record<string,string> = { 'SWITCH':'Switch','switch':'Switch','Wireless controller':'Wireless Controller','ArubaMM-VA':'Aruba MM-VA','ArubaCPPM':'Aruba CPPM' }
  return map[t] || t
}
function normaliseBrand(b: string) {
  const map: Record<string,string> = { 'CISCO':'Cisco','ForcePoint':'Forcepoint','Forcepoint ':'Forcepoint','Netgear ':'Netgear','D-Link ':'D-Link','Dlink':'D-Link','Tplink':'TP-Link','Totolink':'TOTOLINK' }
  return map[b?.trim()] || b?.trim()
}
function normaliseCountry(c: string) {
  const map: Record<string,string> = { 'uK':'UK','Luxemborg':'Luxembourg' }
  return map[c?.trim()] || c?.trim()
}

async function getOrCreate(table: string, col: string, value: string) {
  if (!value) return null
  const res = await query(`SELECT id FROM ${table} WHERE ${col} = $1`, [value])
  if (res.rows[0]) return res.rows[0].id
  const ins = await query(`INSERT INTO ${table} (${col}) VALUES ($1) RETURNING id`, [value])
  return ins.rows[0].id
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string; id: string; siteIds?: number[] }
  if (user.role !== 'admin' && user.role !== 'site_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const formData = await req.formData()
  const file = formData.get('file') as File
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  const text = await file.text()
  const lines = text.split('\n').filter(l => l.trim())
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))

  function getVal(row: string[], key: string) {
    const i = headers.findIndex(h => h.toLowerCase().includes(key.toLowerCase()))
    return i >= 0 ? row[i]?.trim().replace(/^"|"$/g, '') || '' : ''
  }

  let inserted = 0
  const skippedRows: { row: number; name: string; reason: string }[] = []

  for (const [idx, line] of lines.slice(1).entries()) {
    const rowNum = idx + 2 // 1-indexed, +1 for header
    try {
      const vals = line.split(',')
      const country = normaliseCountry(getVal(vals, 'country'))
      const siteName = getVal(vals, 'site')
      const deviceName = getVal(vals, 'name') || `Row ${rowNum}`

      if (!siteName) {
        skippedRows.push({ row: rowNum, name: deviceName, reason: 'Site name is empty' })
        continue
      }
      if (!country) {
        skippedRows.push({ row: rowNum, name: deviceName, reason: 'Country is empty' })
        continue
      }

      const siteRes = await query(
        `SELECT s.id FROM sites s JOIN countries c ON c.id = s.country_id WHERE s.name = $1 AND c.name = $2`,
        [siteName, country]
      )
      if (!siteRes.rows[0]) {
        skippedRows.push({ row: rowNum, name: deviceName, reason: `Site "${siteName}" not found in country "${country}"` })
        continue
      }
      const siteId = siteRes.rows[0].id

      // Site admins can only import to their assigned sites
      if (user.role === 'site_admin' && user.siteIds?.length && !user.siteIds.includes(siteId)) {
        skippedRows.push({ row: rowNum, name: deviceName, reason: `You are not assigned to site "${siteName}"` })
        continue
      }

      const deviceType = normaliseType(getVal(vals, 'type'))
      const brand = normaliseBrand(getVal(vals, 'brand'))
      const deviceTypeId = await getOrCreate('device_types', 'name', deviceType)
      const brandId = brand ? await getOrCreate('brands', 'name', brand) : null

      const ip = getVal(vals, 'ip')
      const validIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null
      if (ip && !validIp) {
        skippedRows.push({ row: rowNum, name: deviceName, reason: `Invalid IP address "${ip}"` })
        continue
      }

      // Check duplicate IP
      if (validIp) {
        const dupIp = await query(`SELECT id FROM devices WHERE ip_address = $1`, [validIp])
        if (dupIp.rows[0]) {
          skippedRows.push({ row: rowNum, name: deviceName, reason: `IP address "${validIp}" already exists in the database` })
          continue
        }
      }

      const lifecycleMap: Record<string,string> = { 'Active, Supported':'Active, Supported','EOL / EOS':'EOL / EOS' }
      const lifecycle = lifecycleMap[getVal(vals, 'lifecycle')] || 'Unknown'
      const statusMap: Record<string,string> = { 'Active':'Active','Decommed':'Decommed','Faulty, Replaced':'Faulty, Replaced','Spare':'Spare' }
      const devStatus = statusMap[getVal(vals, 'status')] || 'Active'

      await query(`
        INSERT INTO devices (
          name, brand_id, model, serial_number, device_type_id,
          ip_address, site_id, lifecycle_status, device_status, created_by, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [
          getVal(vals, 'name') || null,
          brandId,
          getVal(vals, 'model') || null,
          getVal(vals, 's/n') || getVal(vals, 'serial') || null,
          deviceTypeId,
          validIp,
          siteId,
          lifecycle,
          devStatus,
          parseInt(user.id)
        ]
      )
      inserted++
    } catch (e: any) {
      const deviceName = `Row ${rowNum}`
      skippedRows.push({ row: rowNum, name: deviceName, reason: e?.message?.includes('duplicate') ? 'Duplicate entry' : `Database error: ${e?.message || 'unknown'}` })
    }
  }

  return NextResponse.json({ inserted, skipped: skippedRows.length, skippedRows })
}
