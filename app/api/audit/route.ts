import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { resolvePaging } from '@/lib/pagination'

/** What an admin sees in place of a super_admin-only audited value. */
const REDACTED = '(hidden — super admin only)'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }

  const { searchParams } = new URL(req.url)

  // Recent-activity feed mode: `?limit=N` returns a small, read-only recent
  // feed available to any authenticated user (for the launcher widget).
  // Full paginated/filterable audit log remains admin-only.
  const limitParam = searchParams.get('limit')
  if (limitParam) {
    const feedLimit = Math.min(Math.max(parseInt(limitParam, 10) || 8, 1), 25)
    const feed = await query(`
      SELECT a.id, a.field_name, a.changed_at,
             u.name as changed_by_name,
             d.name as device_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.changed_by
      LEFT JOIN devices d ON d.id = a.device_id
      ORDER BY a.changed_at DESC LIMIT $1
    `, [feedLimit])
    return NextResponse.json({ logs: feed.rows })
  }

  if (user.role !== 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const action   = searchParams.get('action') || ''
  const userId   = searchParams.get('user') || ''
  const dateFrom = searchParams.get('from') || ''
  const dateTo   = searchParams.get('to') || ''
  // ⛔ CLAMPED. `page=0` built a negative OFFSET, which PostgreSQL rejects
  // outright, so the audit log answered 500 to a hand-typed query string; a
  // huge `page` is now simply an empty page rather than a 500. The page SIZE is
  // fixed at 50 here (`fixedLimit`), so a caller cannot widen it either — see
  // lib/pagination.ts, which is the only place these two values may be read.
  const { limit, offset } = resolvePaging(searchParams, { fixedLimit: 50 })

  const conditions: string[] = []
  const params: unknown[] = []
  let p = 1

  if (action)   { conditions.push(`a.field_name = $${p}`);               params.push(action);   p++ }
  if (userId)   { conditions.push(`a.changed_by = $${p}`);               params.push(parseInt(userId)); p++ }
  if (dateFrom) { conditions.push(`a.changed_at >= $${p}`);              params.push(dateFrom); p++ }
  if (dateTo)   { conditions.push(`a.changed_at < ($${p}::date + 1)`);   params.push(dateTo);   p++ }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [res, count, users] = await Promise.all([
    query(`
      SELECT a.id, a.field_name, a.old_value, a.new_value, a.changed_at,
             u.name as changed_by_name, u.email as changed_by_email,
             d.name as device_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.changed_by
      LEFT JOIN devices d ON d.id = a.device_id
      ${where}
      ORDER BY a.changed_at DESC LIMIT $${p} OFFSET $${p+1}
    `, [...params, limit, offset]),
    query(`SELECT COUNT(*) FROM audit_log a ${where}`, params),
    query(`SELECT DISTINCT u.id, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.changed_by WHERE u.id IS NOT NULL ORDER BY u.name`),
  ])

  // ⛔ THE SUITE MAIL SERVER'S DETAILS ARE super_admin-ONLY, AND THE AUDIT LOG
  // IS A READ PATH FOR THEM.
  //
  // `PUT /api/suite/smtp` writes a `smtp:<field>` row per changed field, and it
  // is careful: the password is recorded as a presence sentinel, never a value.
  // But `host`, `username` and `from_email` ARE written verbatim, by design —
  // "somebody pointed the suite at a different relay" is exactly the event an
  // auditor needs. The gate on that route is super_admin; the gate on THIS one
  // is admin. So an admin who could not open the Mail server panel could read
  // the whole configuration out of the audit log one field at a time, and watch
  // every future change to it.
  //
  // The EVENT stays visible to an admin — that is what an audit log is for, and
  // hiding "the mail server was changed" from an administrator would be its own
  // kind of dishonesty. Only the two VALUES are withheld, and they are replaced
  // with a marker that says so rather than being blanked, so the page shows
  // "changed" and not "changed to nothing".
  const isSuperAdmin = user.role === 'super_admin'
  const logs = isSuperAdmin ? res.rows : res.rows.map((r: Record<string, unknown>) => {
    const field = typeof r.field_name === 'string' ? r.field_name : ''
    if (!field.startsWith('smtp:')) return r
    // The password row is already a sentinel from the writer, not a value, so
    // it is left exactly as it is — redacting a redaction reads as a second,
    // different fact.
    if (field === 'smtp:password') return r
    return { ...r, old_value: r.old_value == null ? null : REDACTED, new_value: r.new_value == null ? null : REDACTED }
  })

  return NextResponse.json({
    logs,
    total: parseInt(count.rows[0].count),
    users: users.rows,
  })
}
