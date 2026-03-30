import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Only super admins can change branding' }, { status: 403 })
  if (user.role === 'admin') return NextResponse.json({ error: 'Only super admins can change branding' }, { status: 403 })
  if (user.role === 'admin') return NextResponse.json({ error: 'Only super admins can change branding' }, { status: 403 })

  const formData = await req.formData()
  const file = formData.get('file') as File
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp']
  if (!validTypes.includes(file.type))
    return NextResponse.json({ error: 'Invalid file type. Use PNG, JPG, GIF, SVG or WebP' }, { status: 400 })

  if (file.size > 500 * 1024)
    return NextResponse.json({ error: 'File too large. Max 500KB' }, { status: 400 })

  const bytes = await file.arrayBuffer()
  const base64 = Buffer.from(bytes).toString('base64')
  const dataUrl = `data:${file.type};base64,${base64}`

  await query(
    `INSERT INTO app_settings (key, value) VALUES ('app_logo_url', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [dataUrl]
  )

  return NextResponse.json({ url: dataUrl })
}
