import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import * as XLSX from 'xlsx'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin' && user.role !== 'site_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const formData = await req.formData()
  const file = formData.get('file') as File
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  const buffer = await file.arrayBuffer()
  const fileName = file.name.toLowerCase()
  let rows: Record<string, string>[] = []

  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }).map((row: any) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v ?? '')]))
    )
  } else {
    const text = new TextDecoder('utf-8').decode(buffer)
    const lines = text.split('\n').filter(l => l.trim())
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
    rows = lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''))
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] || '']))
    })
  }

  const preview = rows.slice(0, 5)
  return NextResponse.json({ preview, total: rows.length, headers: Object.keys(preview[0] || {}) })
}
