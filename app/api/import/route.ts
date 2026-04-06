import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import * as XLSX from 'xlsx'
import { calcTechnicalDebt } from '@/lib/techDebt'

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
  if (user.role !== 'admin' && user.role !== 'super_admin' && user.role !== 'site_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const formData = await req.formData()
  const file = formData.get('file') as File
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  const buffer = await file.arrayBuffer()
  const fileName = file.name.toLowerCase()

  let allRows: Record<string, string>[] = []

  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    allRows = XLSX.utils.sheet_to_json(sheet, { defval: '' }).map((row: any) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v ?? '')]))
    )
  } else {
    const text = new TextDecoder('utf-8').decode(buffer)
    const lines = text.split('\n').filter(l => l.trim())
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
    allRows = lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''))
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] || '']))
    })
  }

  function getVal(row: Record<string, string>, key: string) {
    const k = Object.keys(row).find(h => h.toLowerCase().includes(key.toLowerCase()))
    return k ? (row[k] || '').trim() : ''
  }

  const dryRun = formData.get('dryRun') === 'true'
  let inserted = 0
  let updated = 0
  const skippedRows: { row: number; name: string; reason: string }[] = []

  for (const [idx, rowData] of allRows.entries()) {
    const rowNum = idx + 2
    try {
      const country = normaliseCountry(getVal(rowData, 'country'))
      const siteName = getVal(rowData, 'site')
      const deviceName = getVal(rowData, 'name') || `Row ${rowNum}`

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

      if (user.role === 'site_admin' && user.siteIds?.length && !user.siteIds.includes(siteId)) {
        skippedRows.push({ row: rowNum, name: deviceName, reason: `You are not assigned to site "${siteName}"` })
        continue
      }

      const deviceType = normaliseType(getVal(rowData, 'type'))
      const brand = normaliseBrand(getVal(rowData, 'brand'))
      const deviceTypeId = await getOrCreate('device_types', 'name', deviceType)
      const brandId = brand ? await getOrCreate('brands', 'name', brand) : null

      const ipRaw = getVal(rowData, 'ip').split('/')[0].trim()
      const validIp = ipRaw ? (/^\d{1,3}(\.\d{1,3}){3}$/.test(ipRaw) ? ipRaw : null) : null
      const ip = ipRaw || null
      if (ip && !validIp) {
        skippedRows.push({ row: rowNum, name: deviceName, reason: `Invalid IP address "${ip}"` })
        continue
      }

      const serialRaw = getVal(rowData, 's/n') || getVal(rowData, 'serial') || null
      const lifecycleMap: Record<string,string> = { 'Active, Supported':'Active, Supported','EOL / EOS':'EOL / EOS' }
      const lifecycle = lifecycleMap[getVal(rowData, 'lifecycle')] || 'Unknown'
      const statusMap: Record<string,string> = { 'Active':'Active','Decommed':'Decommed','Faulty, Replaced':'Faulty, Replaced','Spare':'Spare' }
      const devStatus = statusMap[getVal(rowData, 'status')] || 'Active'

      // Check if device with same serial already exists — upsert if so
      const existingBySerial = serialRaw
        ? await query(`SELECT id FROM devices WHERE serial_number = $1`, [serialRaw])
        : { rows: [] }

      if (existingBySerial.rows[0]) {
        // Update everything except site_id
        if (!dryRun) {
          await query(`
            UPDATE devices SET
              name=$1, brand_id=$2, model=$3,
              device_type_id=$4, ip_address=$5,
              lifecycle_status=$6, device_status=$7,
              technical_debt=$8, updated_by=$9
            WHERE serial_number=$10`,
            [
              getVal(rowData, 'name') || null,
              brandId,
              getVal(rowData, 'model') || null,
              deviceTypeId,
              validIp,
              lifecycle,
              devStatus,
              calcTechnicalDebt(lifecycle, devStatus, deviceType),
              parseInt(user.id),
              serialRaw
            ]
          )
        }
        updated++
        continue
      }

      // New device — check for duplicate IP before inserting
      if (validIp) {
        const dupIp = await query(`SELECT id FROM devices WHERE ip_address = $1`, [validIp])
        if (dupIp.rows[0]) {
          skippedRows.push({ row: rowNum, name: deviceName, reason: `IP address "${validIp}" already exists in the database` })
          continue
        }
      }

      if (!dryRun) {
        await query(`
          INSERT INTO devices (
            name, brand_id, model, serial_number, device_type_id,
            ip_address, site_id, lifecycle_status, device_status, technical_debt, created_by, updated_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
          [
            getVal(rowData, 'name') || null,
            brandId,
            getVal(rowData, 'model') || null,
            serialRaw,
            deviceTypeId,
            validIp,
            siteId,
            lifecycle,
            devStatus,
            calcTechnicalDebt(lifecycle, devStatus, deviceType),
            parseInt(user.id)
          ]
        )
      }
      inserted++
    } catch (e: any) {
      const deviceName = `Row ${rowNum}`
      skippedRows.push({ row: rowNum, name: deviceName, reason: e?.message?.includes('duplicate') ? 'Duplicate entry' : `Database error: ${e?.message || 'unknown'}` })
    }
  }

  return NextResponse.json({ inserted, updated, skipped: skippedRows.length, skippedRows })
}
