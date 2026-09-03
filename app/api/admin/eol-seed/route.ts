import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { ensureEolSchema, normalizeForMatch, previewMatch } from '@/lib/eolEnrich'
import { requireEol } from '@/lib/entitlements'

// Inline super_admin guard (no central requireRole — mirrors DELETE /api/users/[id]).
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
 * GET /api/admin/eol-seed
 * super_admin only. Supports four modes (precedence: groupBy > search > vendor > default):
 *
 *   ?groupBy=vendor
 *     → { groups: [{ vendor, count, dated, dateless, earliest_eol, latest_eos }], total }
 *
 *   ?search=<q> [&page=&pageSize=]
 *     → { entries, total, page, pageSize } filtered across vendor/model/aliases (flat)
 *
 *   ?vendor=<name> [&page=&pageSize=]
 *     → { entries, total, page, pageSize } filtered to one exact vendor
 *
 *   ?page=&pageSize=   (default)
 *     → { entries, total, page, pageSize } — all vendors, paginated
 */
const SEED_COLUMNS = `id, vendor, model_raw, model_normalized, aliases,
        eol_date::text AS eol_date, eos_date::text AS eos_date,
        source_url, confidence, added_by, created_at, updated_at`

export async function GET(req: NextRequest) {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const sp = new URL(req.url).searchParams
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') || '50', 10) || 50))
    const offset = (page - 1) * pageSize

    // Mode 1: group by vendor
    if (sp.get('groupBy') === 'vendor') {
      const groupsRes = await query(
        `SELECT vendor,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE eol_date IS NOT NULL OR eos_date IS NOT NULL)::int AS dated,
                COUNT(*) FILTER (WHERE eol_date IS NULL AND eos_date IS NULL)::int AS dateless,
                MIN(eol_date)::text AS earliest_eol,
                MAX(eos_date)::text AS latest_eos
         FROM eol_seed
         GROUP BY vendor
         ORDER BY count DESC, vendor ASC`
      )
      const totalRes = await query(`SELECT COUNT(*)::int AS total FROM eol_seed`)
      return NextResponse.json({ groups: groupsRes.rows, total: totalRes.rows[0].total as number })
    }

    // Mode 2: search (flat).
    //
    // Two shapes, because the two callers want different things:
    //
    //   default    — vendor + model + ALIASES, single substring. This is the seed
    //                catalog browser: an admin looking for an entry to edit wants
    //                alias hits.
    //   mode=model — vendor + model only, ALIASES EXCLUDED, and every whitespace
    //                token must match. This is the Quick EOL lookup.
    //
    // Aliases are why "2900" returned HPE switches: JG624A carries the alias
    // "flexfabric1290048p10gbesfpe", and "12900" contains "2900" as a substring.
    // Substring-matching a concatenated alias blob is far too loose for a
    // "what is the EOL date for this model" question, so the lookup drops it.
    //
    // Token-AND (rather than dropping vendor too) is what keeps "Cisco 2900"
    // working: 'cisco' matches the vendor, '2900' matches the model, and both
    // must hold. A single-substring match over vendor+model could not satisfy
    // that query at all, since no one column contains the whole string.
    const search = (sp.get('search') || '').trim()
    if (search) {
      const modelOnly = sp.get('mode') === 'model'
      let where: string
      let params: unknown[]

      if (modelOnly) {
        const tokens = search.split(/\s+/).filter(Boolean).slice(0, 6)
        const clauses = tokens.map((_t, i) => {
          const p = i + 1
          return `(vendor ILIKE $${p} OR model_raw ILIKE $${p} OR model_normalized ILIKE $${p})`
        })
        where = `WHERE ${clauses.join(' AND ')}`
        params = tokens.map(t => `%${t}%`)
      } else {
        where = `WHERE (vendor ILIKE $1 OR model_raw ILIKE $1 OR model_normalized ILIKE $1 OR array_to_string(aliases, ' ') ILIKE $1)`
        params = [`%${search}%`]
      }

      const totalRes = await query(`SELECT COUNT(*)::int AS total FROM eol_seed ${where}`, params)
      const total = totalRes.rows[0].total as number
      const res = await query(
        `SELECT ${SEED_COLUMNS}
         FROM eol_seed
         ${where}
         ORDER BY vendor, model_raw, id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset]
      )
      return NextResponse.json({ entries: res.rows, total, page, pageSize })
    }

    // Mode 3: single exact vendor
    const vendor = (sp.get('vendor') || '').trim()
    if (vendor) {
      const totalRes = await query(
        `SELECT COUNT(*)::int AS total FROM eol_seed WHERE vendor = $1`,
        [vendor]
      )
      const total = totalRes.rows[0].total as number
      const res = await query(
        `SELECT ${SEED_COLUMNS}
         FROM eol_seed
         WHERE vendor = $1
         ORDER BY vendor, model_raw, id
         LIMIT $2 OFFSET $3`,
        [vendor, pageSize, offset]
      )
      return NextResponse.json({ entries: res.rows, total, page, pageSize })
    }

    // Mode 4 (default): all vendors, paginated
    const totalRes = await query(`SELECT COUNT(*)::int AS total FROM eol_seed`)
    const total = totalRes.rows[0].total as number

    const res = await query(
      `SELECT ${SEED_COLUMNS}
       FROM eol_seed
       ORDER BY vendor, model_raw, id
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    )
    return NextResponse.json({ entries: res.rows, total, page, pageSize })
  } catch (err) {
    console.error('[admin/eol-seed GET]', err)
    return NextResponse.json({ error: 'Failed to load seed entries' }, { status: 500 })
  }
}

/**
 * POST /api/admin/eol-seed — add a seed entry.
 * Body: { vendor, model_raw, aliases?, eol_date?, eos_date?, source_url?, confidence? }
 * Auto-normalizes model_raw → model_normalized (and aliases).
 *
 * Response: { ok:true, id, normalized, matchPreview: { count, sample } }
 */
export async function POST(req: NextRequest) {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const body = await req.json().catch(() => ({}))
    const vendor = (body.vendor ?? '').toString().trim()
    const modelRaw = (body.model_raw ?? '').toString().trim()
    if (!vendor || !modelRaw) {
      return NextResponse.json({ error: 'vendor and model_raw are required' }, { status: 400 })
    }

    const normalized = normalizeForMatch(vendor, modelRaw)
    const aliasesIn: string[] = Array.isArray(body.aliases) ? body.aliases : []
    const aliasNorms = aliasesIn
      .map((a) => normalizeForMatch(vendor, String(a)))
      .filter((a) => a && a !== normalized)
    const confidence = ['high', 'medium', 'low'].includes(body.confidence) ? body.confidence : 'high'
    const addedBy = guard.user.id ? `user:${guard.user.id}` : 'admin'

    const inserted = await query(
      `INSERT INTO eol_seed
         (vendor, model_raw, model_normalized, aliases, eol_date, eos_date, source_url, confidence, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        vendor,
        modelRaw,
        normalized,
        aliasNorms,
        body.eol_date || null,
        body.eos_date || null,
        body.source_url || null,
        confidence,
        addedBy,
      ]
    )
    const id = inserted.rows[0].id as number

    // Preview how many devices this entry matches (read-only).
    const preview = await previewMatch(vendor, modelRaw, { aliases: aliasesIn })

    return NextResponse.json({
      ok: true,
      id,
      normalized,
      matchPreview: { count: preview.count, sample: preview.sample },
    })
  } catch (err) {
    console.error('[admin/eol-seed POST]', err)
    return NextResponse.json({ error: 'Failed to add seed entry' }, { status: 500 })
  }
}
