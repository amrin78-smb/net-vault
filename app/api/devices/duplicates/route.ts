import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const duplicates: {
    field: string; value: string; count: number;
    classification: string; color: string;
    /** 'ok' | 'review' | 'high'. Added so the UI does not have to detect
     *  severity by string-matching an emoji prefix on `classification`. */
    severity: string;
    devices: { id: string; name: string; site: string; device_type: string; serial: string }[]
  }[] = []

  // Duplicate IPs with full device context
  const ipDups = await query(`
    SELECT
      d.ip_address::text AS value,
      COUNT(*) AS count,
      array_agg(d.id::text) AS device_ids,
      array_agg(d.name) AS names,
      array_agg(COALESCE(s.name, '')) AS sites,
      array_agg(COALESCE(dt.name, '')) AS types,
      array_agg(COALESCE(d.serial_number, '')) AS serials,
      COUNT(DISTINCT COALESCE(s.name, '')) AS site_count,
      COUNT(DISTINCT COALESCE(dt.name, '')) AS type_count,
      COUNT(DISTINCT d.name) AS name_count,
      SUM(CASE WHEN d.serial_number IS NOT NULL AND d.serial_number != '' THEN 1 ELSE 0 END) AS serial_count,
      COUNT(DISTINCT COALESCE(d.serial_number, '')) AS unique_serials
    FROM devices d
    LEFT JOIN sites s ON s.id = d.site_id
    LEFT JOIN device_types dt ON dt.id = d.device_type_id
    WHERE d.ip_address IS NOT NULL
    GROUP BY d.ip_address
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `)

  for (const row of ipDups.rows) {
    const siteCount = parseInt(row.site_count)
    const typeCount = parseInt(row.type_count)
    const nameCount = parseInt(row.name_count)
    const serialCount = parseInt(row.serial_count)
    const uniqueSerials = parseInt(row.unique_serials)
    const lastOctet = parseInt((row.value.split('/')[0]).split('.').pop() || '0')
    const isGatewayIp = [0, 1, 254, 255].includes(lastOctet)

    let classification = ''
    let color = ''

    if (siteCount > 1 && uniqueSerials >= siteCount) {
      classification = 'Different sites — likely valid IP reuse'
      color = '#dcfce7'
    } else if (isGatewayIp && siteCount > 1) {
      classification = 'Gateway IP reused across sites — valid'
      color = '#dcfce7'
    } else if (serialCount > 0 && uniqueSerials === parseInt(row.count) && nameCount <= 2) {
      classification = 'Stack or cluster — same IP, different serials'
      color = '#fef9c3'
    } else if (nameCount === 1 && uniqueSerials < parseInt(row.count)) {
      classification = 'Same name, same site — likely real duplicate'
      color = '#fee2e2'
    } else if (siteCount === 1 && uniqueSerials < parseInt(row.count) && uniqueSerials <= 1) {
      classification = 'Same site, same serial — likely real duplicate'
      color = '#fee2e2'
    } else if (siteCount === 1) {
      classification = 'Same site — review if stack/cluster or duplicate'
      color = '#fef9c3'
    } else {
      classification = 'Needs manual review'
      color = '#fef9c3'
    }

    duplicates.push({
      field: 'IP Address',
      value: row.value,
      count: parseInt(row.count),
      classification,
      color,
      severity: color === '#fee2e2' ? 'high' : color === '#fef9c3' ? 'review' : 'ok',
      devices: row.device_ids.map((id: string, i: number) => ({
        id,
        name: row.names[i],
        site: row.sites[i],
        device_type: row.types[i],
        serial: row.serials[i],
      }))
    })
  }

  // Duplicate serial numbers
  const snDups = await query(`
    SELECT
      d.serial_number AS value,
      COUNT(*) AS count,
      array_agg(d.id::text) AS device_ids,
      array_agg(d.name) AS names,
      array_agg(COALESCE(s.name, '')) AS sites,
      array_agg(COALESCE(dt.name, '')) AS types,
      COUNT(DISTINCT COALESCE(s.name, '')) AS site_count,
      COUNT(DISTINCT d.name) AS name_count
    FROM devices d
    LEFT JOIN sites s ON s.id = d.site_id
    LEFT JOIN device_types dt ON dt.id = d.device_type_id
    WHERE d.serial_number IS NOT NULL AND d.serial_number != '' AND d.serial_number != 'nan'
    GROUP BY d.serial_number
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `)

  for (const row of snDups.rows) {
    const siteCount = parseInt(row.site_count)
    const nameCount = parseInt(row.name_count)

    let classification = ''
    let color = ''

    if (nameCount === 1 && siteCount === 1) {
      classification = 'Same name, same site, same serial — exact duplicate'
      color = '#fee2e2'
    } else if (siteCount === 1 && nameCount > 1) {
      classification = 'Same site, different names, same serial — renamed device or duplicate'
      color = '#fee2e2'
    } else if (siteCount > 1) {
      classification = 'Same serial across multiple sites — data entry error'
      color = '#fee2e2'
    } else {
      classification = 'Needs manual review'
      color = '#fef9c3'
    }

    duplicates.push({
      field: 'Serial Number',
      value: row.value,
      count: parseInt(row.count),
      classification,
      color,
      severity: color === '#fee2e2' ? 'high' : color === '#fef9c3' ? 'review' : 'ok',
      devices: row.device_ids.map((id: string, i: number) => ({
        id,
        name: row.names[i],
        site: row.sites[i],
        device_type: row.types[i],
        serial: row.value,
      }))
    })
  }

  // Summary counts
  // Counted off `severity`, not an emoji prefix on the text. The prefixes are
  // gone: they were display decoration living inside a data field, which made
  // the wording of a sentence load-bearing for the arithmetic below.
  const red = duplicates.filter(d => d.severity === 'high').length
  const yellow = duplicates.filter(d => d.severity === 'review').length
  const green = duplicates.filter(d => d.severity === 'ok').length

  return NextResponse.json({ duplicates, summary: { red, yellow, green, total: duplicates.length } })
}
