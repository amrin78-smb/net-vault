import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { requireEol } from '@/lib/entitlements'
import { query } from '@/lib/db'
import { ensureEolSchema, normalizeForMatch } from '@/lib/eolEnrich'

async function requireSuperAdmin() {
  const session = await getServerSession(authOptions)
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const user = session.user as { id?: string; role?: string }
  if (user.role !== 'super_admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { user }
}

/**
 * PUT /api/admin/eol-seed/[id] — edit a seed entry.
 * Editable: vendor, model_raw, aliases, eol_date, eos_date, source_url, confidence.
 * If vendor/model_raw/aliases change, model_normalized + alias norms are
 * recomputed. Bumps updated_at. super_admin only.
 *
 * Response: { ok:true, id, normalized }
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const { id } = await params
    const body = await req.json().catch(() => ({}))

    const cur = await query(`SELECT vendor, model_raw FROM eol_seed WHERE id = $1`, [id])
    if (cur.rows.length === 0) {
      return NextResponse.json({ error: 'Seed entry not found' }, { status: 404 })
    }

    const vendor = body.vendor !== undefined ? String(body.vendor).trim() : cur.rows[0].vendor
    const modelRaw = body.model_raw !== undefined ? String(body.model_raw).trim() : cur.rows[0].model_raw
    const normalized = normalizeForMatch(vendor, modelRaw)

    const sets: string[] = []
    const vals: unknown[] = []
    let p = 1

    sets.push(`vendor = $${p++}`); vals.push(vendor)
    sets.push(`model_raw = $${p++}`); vals.push(modelRaw)
    sets.push(`model_normalized = $${p++}`); vals.push(normalized)

    if (body.aliases !== undefined) {
      const aliasNorms = (Array.isArray(body.aliases) ? body.aliases : [])
        .map((a: unknown) => normalizeForMatch(vendor, String(a)))
        .filter((a: string) => a && a !== normalized)
      sets.push(`aliases = $${p++}`); vals.push(aliasNorms)
    }
    if (body.eol_date !== undefined) { sets.push(`eol_date = $${p++}`); vals.push(body.eol_date || null) }
    if (body.eos_date !== undefined) { sets.push(`eos_date = $${p++}`); vals.push(body.eos_date || null) }
    if (body.source_url !== undefined) { sets.push(`source_url = $${p++}`); vals.push(body.source_url || null) }
    if (body.confidence !== undefined) {
      const c = ['high', 'medium', 'low'].includes(body.confidence) ? body.confidence : 'high'
      sets.push(`confidence = $${p++}`); vals.push(c)
    }
    sets.push(`updated_at = NOW()`)

    vals.push(id)
    await query(`UPDATE eol_seed SET ${sets.join(', ')} WHERE id = $${p}`, vals)

    return NextResponse.json({ ok: true, id: Number(id), normalized })
  } catch (err) {
    console.error('[admin/eol-seed/[id] PUT]', err)
    return NextResponse.json({ error: 'Failed to update seed entry' }, { status: 500 })
  }
}

/**
 * DELETE /api/admin/eol-seed/[id] — remove a seed entry. super_admin only.
 * Response: { ok:true }
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const { id } = await params
    await query(`DELETE FROM eol_seed WHERE id = $1`, [id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[admin/eol-seed/[id] DELETE]', err)
    return NextResponse.json({ error: 'Failed to delete seed entry' }, { status: 500 })
  }
}
