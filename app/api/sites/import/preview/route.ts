import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import * as XLSX from 'xlsx'

const PREVIEW_CAP = 200

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

  // CSV — quote-aware parse (handles commas inside quoted fields).
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

// Flexible, case-insensitive header matching. Each field lists accepted header
// aliases (normalized: lowercased, non-alphanumerics stripped). First alias that
// appears as a substring of (or equals) a normalized column key wins.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const FIELD_ALIASES: Record<string, string[]> = {
  name: ['sitename', 'site', 'sitename', 'name'],
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

// Order matters: match the most specific aliases first so e.g. a "Contact Email"
// column binds to contact_email before a bare "email" alias would, and "Site Type"
// isn't swallowed by "Site Name" matching. We resolve per-field against the columns.
function buildGetVal(row: Record<string, string>) {
  const cols = Object.keys(row)
  const normCols = cols.map((c) => ({ raw: c, n: norm(c) }))
  const cache: Record<string, string> = {}
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    let hit = ''
    for (const alias of aliases) {
      // Prefer exact normalized equality, then substring containment.
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

const FIELD_LABELS: Record<string, string> = {
  code: 'Code',
  address: 'Address',
  city: 'City',
  postal_code: 'Postal Code',
  site_type: 'Site Type',
  coordinates: 'Coordinates',
  phone: 'Phone',
  contact_name: 'Contact Name',
  contact_email: 'Contact Email',
}
const FILLABLE = ['code', 'address', 'city', 'postal_code', 'site_type', 'coordinates', 'phone', 'contact_name', 'contact_email'] as const

function isEmpty(v: unknown) {
  return v === null || v === undefined || String(v).trim() === ''
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const user = session.user as { role?: string }
    if (user?.role !== 'admin' && user?.role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const formData = await req.formData()
    const file = formData.get('file') as File
    if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

    const allRows = await parseFile(file)
    const total = allRows.length
    const truncated = total > PREVIEW_CAP
    const rows = truncated ? allRows.slice(0, PREVIEW_CAP) : allRows

    const preview: any[] = []

    for (const [idx, rowData] of rows.entries()) {
      const rowNum = idx + 2 // 1-based incl. header row
      const get = buildGetVal(rowData)
      const name = get('name')
      const code = get('code')
      const country = get('country')
      const region = get('region')

      if (!name) {
        preview.push({ row: rowNum, name: '', code, country, region, action: 'skip', fills: [], reason: 'Missing site name' })
        continue
      }
      if (!country) {
        preview.push({ row: rowNum, name, code, country, region, action: 'skip', fills: [], reason: 'Missing country' })
        continue
      }

      // Resolve country id (read-only in preview — never creates).
      const countryRes = await query(
        `SELECT id FROM countries WHERE lower(name) = lower($1) OR lower(iso_code) = lower($1) LIMIT 1`,
        [country]
      )
      const countryId: number | null = countryRes.rows[0]?.id ?? null

      // Find a matching site: by code (case-insensitive) if provided, else by
      // name + resolved country.
      let existing: any = null
      if (code) {
        const byCode = await query(
          `SELECT id, code, address, city, postal_code, site_type, coordinates, phone, contact_name, contact_email
             FROM sites WHERE lower(code) = lower($1) LIMIT 1`,
          [code]
        )
        existing = byCode.rows[0] || null
      }
      if (!existing && countryId != null) {
        const byName = await query(
          `SELECT id, code, address, city, postal_code, site_type, coordinates, phone, contact_name, contact_email
             FROM sites WHERE lower(name) = lower($1) AND country_id = $2 LIMIT 1`,
          [name, countryId]
        )
        existing = byName.rows[0] || null
      }

      if (existing) {
        // Compute which fields WOULD be filled (empty in DB, provided in row).
        const fills: string[] = []
        for (const f of FILLABLE) {
          const rowVal = get(f)
          if (!isEmpty(rowVal) && isEmpty(existing[f])) fills.push(FIELD_LABELS[f])
        }
        if (fills.length) {
          preview.push({ row: rowNum, name, code, country, region, action: 'update', fills, reason: `Would fill ${fills.length} empty field(s)` })
        } else {
          preview.push({ row: rowNum, name, code, country, region, action: 'skip', fills: [], reason: 'Already complete (no empty fields to fill)' })
        }
        continue
      }

      // No match → create. Country may need to be created at import time; that's
      // fine here (a region + country can be created), so the plan is 'create'.
      preview.push({ row: rowNum, name, code, country, region, action: 'create', fills: [], reason: countryId != null ? 'New site' : 'New site (country will be created)' })
    }

    return NextResponse.json({ preview, total, truncated, ...(truncated ? { previewCount: rows.length } : {}) })
  } catch (e) {
    console.error('[sites/import/preview POST]', e)
    return NextResponse.json({ error: 'Failed to preview import' }, { status: 500 })
  }
}
