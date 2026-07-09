import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { withTransaction } from '@/lib/db'
import { checkWriteAllowed } from '@/app/api/license/route'
import * as XLSX from 'xlsx'
import type { PoolClient } from 'pg'

// ---- shared parse (mirrors the device importer: xlsx via XLSX.read, else CSV) ----
async function parseFile(file: File): Promise<Record<string, string>[]> {
  const buffer = await file.arrayBuffer()
  const fileName = file.name.toLowerCase()

  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    return XLSX.utils.sheet_to_json(sheet, { defval: '' }).map((row: any) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v ?? '')]))
    )
  }

  const text = new TextDecoder('utf-8').decode(buffer)
  const lines: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === '\n' && !inQuotes) { lines.push(current); current = ''; continue }
    else if (ch === '\r') continue
    current += ch
  }
  if (current.trim()) lines.push(current)
  if (!lines.length) return []
  const parseRow = (line: string): string[] => {
    const fields: string[] = []
    let field = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') inQ = !inQ
      else if (ch === ',' && !inQ) { fields.push(field.trim()); field = ''; continue }
      else field += ch
    }
    fields.push(field.trim())
    return fields
  }
  const headers = parseRow(lines[0])
  return lines.slice(1).filter((l) => l.trim()).map((line) => {
    const vals = parseRow(line)
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] || '']))
  })
}

// ---- flexible header matching (must match preview/route.ts) ----
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const FIELD_ALIASES: Record<string, string[]> = {
  name: ['sitename', 'site', 'name'],
  code: ['sitecode', 'code'],
  region: ['region'],
  country: ['country'],
  address: ['address', 'street'],
  city: ['city', 'town'],
  postal_code: ['postalcode', 'postcode', 'zip', 'zipcode', 'postal'],
  site_type: ['sitetype', 'type'],
  coordinates: ['coordinates', 'coords', 'latlng', 'geo'],
  phone: ['phone', 'tel', 'telephone'],
  contact_name: ['contactname', 'contact'],
  contact_email: ['contactemail', 'email'],
}

function buildGetVal(row: Record<string, string>) {
  const normCols = Object.keys(row).map((c) => ({ raw: c, n: norm(c) }))
  const cache: Record<string, string> = {}
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    let hit = ''
    for (const alias of aliases) {
      const exact = normCols.find((c) => c.n === alias)
      const found = exact || normCols.find((c) => c.n.includes(alias))
      if (found) { hit = found.raw; break }
    }
    cache[field] = hit
  }
  return (field: string) => {
    const col = cache[field]
    return col ? (row[col] || '').trim() : ''
  }
}

const FILLABLE = ['code', 'address', 'city', 'postal_code', 'site_type', 'coordinates', 'phone', 'contact_name', 'contact_email'] as const

function isEmpty(v: unknown) {
  return v === null || v === undefined || String(v).trim() === ''
}

// Resolve (and, if needed, create) a country id from a name/region. Uses the
// passed transaction client so a dryRun rollback undoes any created rows.
// Writes only happen when write === true (dryRun gates every mutation).
async function resolveCountry(
  client: PoolClient,
  countryName: string,
  regionName: string,
  write: boolean
): Promise<number | null> {
  if (isEmpty(countryName)) return null
  const found = await client.query(
    `SELECT id FROM countries WHERE lower(name) = lower($1) OR lower(iso_code) = lower($1) LIMIT 1`,
    [countryName]
  )
  if (found.rows[0]) return found.rows[0].id

  // Need to create the country. Resolve/create its region first.
  let regionId: number | null = null
  if (!isEmpty(regionName)) {
    const rFound = await client.query(`SELECT id FROM regions WHERE lower(name) = lower($1) LIMIT 1`, [regionName])
    if (rFound.rows[0]) {
      regionId = rFound.rows[0].id
    } else if (write) {
      const rIns = await client.query(`INSERT INTO regions (name) VALUES ($1) RETURNING id`, [regionName])
      regionId = rIns.rows[0].id
    } else {
      // dryRun: region would be created — use a placeholder so the country insert
      // is skipped but the plan still counts as creatable.
      regionId = null
    }
  }

  if (!write) {
    // In dryRun we don't actually insert; signal "creatable" with a sentinel.
    return -1
  }

  const iso = null // No reliable ISO derivation from a free-text country name.
  const cIns = await client.query(
    `INSERT INTO countries (name, region_id, iso_code) VALUES ($1, $2, $3) RETURNING id`,
    [countryName, regionId, iso]
  )
  return cIns.rows[0].id
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const writeBlock = await checkWriteAllowed(); if (writeBlock) return writeBlock
  const user = session.user as { role?: string }
  // Import can create sites, so restrict to admin / super_admin (mirrors
  // /api/sites/manage — site_admin cannot create sites).
  if (user?.role !== 'admin' && user?.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let allRows: Record<string, string>[]
  let dryRun: boolean
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })
    dryRun = formData.get('dryRun') === 'true'
    allRows = await parseFile(file)
  } catch (e) {
    console.error('[sites/import POST parse]', e)
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 })
  }

  try {
    const result = await withTransaction(async (client) => {
      let created = 0
      let updated = 0
      let filledFields = 0
      const skippedRows: { row: number; name: string; reason: string }[] = []
      const write = !dryRun

      for (const [idx, rowData] of allRows.entries()) {
        const rowNum = idx + 2
        const get = buildGetVal(rowData)
        const name = get('name')
        const code = get('code')
        const country = get('country')
        const region = get('region')

        if (!name) {
          skippedRows.push({ row: rowNum, name: '', reason: 'Missing site name' })
          continue
        }
        if (!country) {
          skippedRows.push({ row: rowNum, name, reason: 'Missing country' })
          continue
        }

        // Resolve existing country id (no create yet — matching only needs it for
        // the name+country lookup).
        const existingCountry = await client.query(
          `SELECT id FROM countries WHERE lower(name) = lower($1) OR lower(iso_code) = lower($1) LIMIT 1`,
          [country]
        )
        const existingCountryId: number | null = existingCountry.rows[0]?.id ?? null

        // MATCH: by code (case-insensitive) if provided, else name + country.
        let existing: any = null
        if (code) {
          const byCode = await client.query(
            `SELECT id, code, address, city, postal_code, site_type, coordinates, phone, contact_name, contact_email
               FROM sites WHERE lower(code) = lower($1) LIMIT 1`,
            [code]
          )
          existing = byCode.rows[0] || null
        }
        if (!existing && existingCountryId != null) {
          const byName = await client.query(
            `SELECT id, code, address, city, postal_code, site_type, coordinates, phone, contact_name, contact_email
               FROM sites WHERE lower(name) = lower($1) AND country_id = $2 LIMIT 1`,
            [name, existingCountryId]
          )
          existing = byName.rows[0] || null
        }

        if (existing) {
          // FILL-EMPTY-ONLY: only set fields that are empty in the DB.
          const setCols: string[] = []
          const setVals: unknown[] = []
          for (const f of FILLABLE) {
            const rowVal = get(f)
            if (!isEmpty(rowVal) && isEmpty(existing[f])) {
              setVals.push(rowVal)
              setCols.push(`${f} = $${setVals.length}`)
            }
          }
          if (setCols.length === 0) {
            skippedRows.push({ row: rowNum, name, reason: 'Already complete (no empty fields to fill)' })
            continue
          }
          if (write) {
            setVals.push(existing.id)
            await client.query(
              `UPDATE sites SET ${setCols.join(', ')}, updated_at = NOW() WHERE id = $${setVals.length}`,
              setVals
            )
          }
          updated++
          filledFields += setCols.length
          continue
        }

        // NO match → CREATE. Need name (have it) + a resolvable/creatable country.
        let countryId: number | null = existingCountryId
        if (countryId == null) {
          try {
            countryId = await resolveCountry(client, country, region, write)
          } catch (e) {
            console.error('[sites/import resolveCountry]', e)
            skippedRows.push({ row: rowNum, name, reason: `Could not resolve country "${country}"` })
            continue
          }
        }
        if (countryId == null) {
          skippedRows.push({ row: rowNum, name, reason: `Could not resolve or create country "${country}"` })
          continue
        }

        if (write) {
          // countryId is real here (resolveCountry only returns -1 in dryRun).
          await client.query(
            `INSERT INTO sites (name, code, country_id, address, city, postal_code, coordinates, site_type, phone, contact_name, contact_email)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              name,
              get('code') || null,
              countryId,
              get('address') || null,
              get('city') || null,
              get('postal_code') || null,
              get('coordinates') || null,
              get('site_type') || null,
              get('phone') || null,
              get('contact_name') || null,
              get('contact_email') || null,
            ]
          )
        }
        created++
      }

      // dryRun: throw a sentinel so withTransaction ROLLBACKs — nothing persists,
      // but the counts we computed are returned to the caller below.
      if (dryRun) {
        const err: any = new Error('__DRY_RUN_ROLLBACK__')
        err.__counts = { created, updated, skipped: skippedRows.length, filledFields, skippedRows }
        throw err
      }
      return { created, updated, skipped: skippedRows.length, filledFields, skippedRows }
    })

    return NextResponse.json(result)
  } catch (e: any) {
    if (e?.message === '__DRY_RUN_ROLLBACK__' && e.__counts) {
      // Expected rollback path for dryRun — return the computed plan counts.
      return NextResponse.json(e.__counts)
    }
    console.error('[sites/import POST]', e)
    return NextResponse.json({ error: 'Failed to import sites' }, { status: 500 })
  }
}
