import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import * as XLSX from 'xlsx'

// Exact header text the importer + preview understand. Keep in sync with the
// header-matching in ./route.ts and ./preview/route.ts.
const HEADERS = [
  'Site Name',
  'Code',
  'Region',
  'Country',
  'Address',
  'City',
  'Postal Code',
  'Site Type',
  'Coordinates',
  'Phone',
  'Contact Name',
  'Contact Email',
] as const

// A clearly-labelled sample row so users see the expected format at a glance.
const EXAMPLE_ROW: Record<(typeof HEADERS)[number], string> = {
  'Site Name': 'EXAMPLE — London HQ',
  Code: 'LON-HQ',
  Region: 'Europe',
  Country: 'United Kingdom',
  Address: '10 Example Street',
  City: 'London',
  'Postal Code': 'EC1A 1BB',
  'Site Type': 'Datacenter',
  Coordinates: '51.5074, -0.1278',
  Phone: '+44 20 7946 0000',
  'Contact Name': 'Jane Doe',
  'Contact Email': 'jane.doe@example.com',
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const user = session.user as { role?: string }
    if (user?.role !== 'admin' && user?.role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Header row + one labelled example row.
    const aoa: string[][] = [
      [...HEADERS],
      HEADERS.map((h) => EXAMPLE_ROW[h]),
    ]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    // Give columns a sensible width so the template is readable.
    ws['!cols'] = HEADERS.map((h) => ({ wch: Math.max(h.length + 2, 16) }))

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sites')

    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    // Copy into a plain Uint8Array (a valid BodyInit) — Node's Buffer isn't
    // directly assignable to BodyInit under this TS config.
    const body = new Uint8Array(buf)

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="NetVault-Sites-Template.xlsx"',
        'Content-Length': String(body.length),
      },
    })
  } catch (e) {
    console.error('[sites/import/template GET]', e)
    return NextResponse.json({ error: 'Failed to build template' }, { status: 500 })
  }
}
