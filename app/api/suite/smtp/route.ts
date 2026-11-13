import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'

import { query } from '@/lib/db.ts'
import { credSecretConfigured, encryptCred } from '@/lib/credStore.ts'
import { ABSENT, PRESENT, recordSystemChanges } from '@/lib/systemAudit.ts'

export const dynamic = 'force-dynamic'

// Settings → Notifications. The SUITE-WIDE SMTP transport, owned by the hub.
// See docs/nocvault-smtp-centralization-plan.md §3-§4.
//
// ⛔ THIS IS A ROUTE, NOT A SETTINGS KEY, AND THAT IS THE WHOLE POINT.
// `app/api/settings/route.ts`'s GET takes NO SESSION — the launcher and
// components/IdleTimeout.tsx fetch it unauthenticated for branding — and it
// redacts exactly one key, `license_key`. Every other `app_settings` row is
// served to anonymous callers, so an `smtp_pass` key there would publish the
// SMTP password on the login surface. `smtp_config` is a dedicated table
// precisely so that reading it requires passing the gate below. Note the
// asymmetry that makes this easy to get wrong: `app_settings_public` is a
// 5-key branding allowlist, so the readonly diagnostic roles would have been
// safe — the leak was in the HTTP route, not the grant. Checking only the view
// would have cleared that design.
//
// ⛔ super_admin ON BOTH METHODS, MATCHING THE BLAST RADIUS — the same
// reasoning that moved POST /api/system/tls from admin+ to super_admin. This is
// ONE transport for all four consoles: repointing `host` silently redirects
// every alert mail the suite sends — LogVault alerts, DDIVault alerts and
// reports, SpanVault scheduled reports — to a server the caller chooses. That
// is EXFILTRATION, not an outage: it is not bounded by anything and nobody
// notices by looking at the console. GET is gated just as hard as PUT, because
// the thing GET reports (which relay, which account, whether a credential
// exists) is reconnaissance for exactly that move.
//
// ⛔ THE PASSWORD IS NEVER RETURNED, BY ANY HANDLER, IN ANY SHAPE — not the
// plaintext, not the ciphertext, not a masked string. Write-only, the same
// treatment `lib/systemAudit.ts` gives the Entra client secret and
// /api/system/tls gives the private key.
//   - NOT THE CIPHERTEXT, because `lib/credStore.ts` derives its key from
//     sha256(NEXTAUTH_SECRET) and that secret is the SAME VALUE IN ALL FOUR
//     APPS (it is the SSO signing secret). To anyone holding it the ciphertext
//     IS the password; it is encrypted at rest to defend against a DB dump and
//     the readonly diagnostic roles, not against a reader of this response.
//   - NOT A MASKED STRING, because a mask that travels is a mask a form posts
//     back, and the very next thing this file does is decide whether an
//     incoming value is "new". `password_set` is the boolean the UI actually
//     needs ("is there one on file"), and it cannot be mistaken for a value.
//
// ⛔ `secret_configured` EXISTS SO A MISSING NEXTAUTH_SECRET IS A WARNING, NOT A
// MYSTERY. `encryptCred` THROWS without it, so on such an install the form
// looks fine, accepts a password and fails at save — PUT answers 503 there, but
// the admin should have been told before typing a credential into a box that
// cannot store it.

// DDIVault's convention, kept byte-identical so the UI and the satellites agree
// on one sentinel: a form that never re-typed the password posts this back, and
// it means KEEP WHAT IS STORED. See PUT.
const PASSWORD_PLACEHOLDER = '********'

type SessionUser = { id?: number | string; role?: string }

type SmtpRow = {
  id: number
  host: string | null
  port: number | string | null
  secure: boolean | null
  username: string | null
  password: string | null
  from_email: string | null
  from_name: string | null
  enabled: boolean | null
  allow_self_signed: boolean | null
  updated_at: string | Date | null
}

function userOf(session: unknown): SessionUser {
  return ((session as { user?: SessionUser } | null)?.user || {}) as SessionUser
}

/**
 * The one gate, shared by both methods so they cannot drift apart.
 *
 * Returns the acting user on success (the audit actor ⛔ comes from the
 * SESSION, never from a request body) or the refusal to return verbatim.
 */
async function gate(): Promise<
  { ok: true; actorId: number | string | undefined } | { ok: false; res: NextResponse }
> {
  const session = await getServerSession(authOptions)
  if (!session) {
    return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const user = userOf(session)
  if (user.role !== 'super_admin') {
    return {
      ok: false,
      res: NextResponse.json(
        {
          error:
            'The suite SMTP transport is shared by all four consoles and requires a super admin.',
        },
        { status: 403 },
      ),
    }
  }
  return { ok: true, actorId: user.id }
}

/** The single row, or null. `ORDER BY id LIMIT 1` mirrors DDIVault's. */
async function loadRow(): Promise<SmtpRow | null> {
  const res = await query('SELECT * FROM smtp_config ORDER BY id LIMIT 1')
  return (res.rows[0] as SmtpRow | undefined) || null
}

/**
 * Coerce a JSON value to a boolean.
 *
 * ⛔ A JSON STRING `"false"` MUST NOT READ AS TRUE. `Boolean("false")` is
 * `true`, and the one field where that matters most is `allow_self_signed`: a
 * checkbox serialized as a string would silently turn OFF certificate
 * verification for every mail the suite sends, which is invisible until someone
 * is reading the alerts off a relay they stood up. An unrecognised value falls
 * back to what is already stored rather than guessing.
 */
function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
    if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false
  }
  return fallback
}

/** A supplied, trimmed string — or null meaning "the body did not say". */
function str(v: unknown): string | null {
  return typeof v === 'string' ? v.trim() : null
}

/**
 * GET — what is configured, minus the one thing that may never leave.
 *
 * `{ data: null }` when nothing has been saved yet. `secret_configured` is
 * reported at the TOP LEVEL as well as inside `data`, because the install that
 * most needs the "NEXTAUTH_SECRET is missing" warning is precisely the one with
 * no row to hang it off.
 */
export async function GET() {
  const g = await gate()
  if (!g.ok) return g.res

  const secretConfigured = credSecretConfigured()

  try {
    const row = await loadRow()
    if (!row) return NextResponse.json({ data: null, secret_configured: secretConfigured })

    return NextResponse.json({
      data: {
        host: row.host || '',
        port: row.port === null || row.port === undefined ? null : Number(row.port),
        secure: Boolean(row.secure),
        username: row.username || '',
        from_email: row.from_email || '',
        from_name: row.from_name || '',
        enabled: Boolean(row.enabled),
        allow_self_signed: Boolean(row.allow_self_signed),
        updated_at: row.updated_at,
        // ⛔ PRESENCE, NEVER CONTENT — and derived here rather than by handing
        // the column to the client to measure.
        password_set: typeof row.password === 'string' && row.password !== '',
        secret_configured: secretConfigured,
      },
      secret_configured: secretConfigured,
    })
  } catch (err) {
    console.error('[suite-smtp] GET failed:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PUT — upsert the single row.
 *
 * ⛔ AN ABSENT PASSWORD MEANS "KEEP", NEVER "CLEAR". The form that edits a port
 * number has no password to send, because GET never gave it one; treating that
 * as a blank would wipe the credential every time somebody fixed a typo in the
 * From name. `''` and the `'********'` placeholder mean the same thing. Only a
 * genuinely new value is re-encrypted. Every other field is merged over what is
 * stored for the same reason — a field the body does not mention is not a field
 * the admin cleared.
 *
 * ⛔ IF ENCRYPTION IS IMPOSSIBLE, NOTHING IS STORED. `encryptCred` throws when
 * NEXTAUTH_SECRET is absent; the answer is a 503 naming the variable, never a
 * plaintext fallback. A "temporary" plaintext write here is a password sitting
 * in a table the readonly diagnostic roles are explicitly fenced off from, and
 * nothing would ever come back to re-encrypt it.
 */
export async function PUT(req: NextRequest) {
  const g = await gate()
  if (!g.ok) return g.res

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  let existing: SmtpRow | null
  try {
    existing = await loadRow()
  } catch (err) {
    console.error('[suite-smtp] PUT could not read the current configuration:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const host = str(body.host) ?? (existing?.host || '')
  const username = str(body.username) ?? (existing?.username || '')
  const fromEmail = str(body.from_email) ?? (existing?.from_email || '')
  const fromName = str(body.from_name) ?? (existing?.from_name || 'NocVault')
  const secure = toBool(body.secure, Boolean(existing?.secure))
  const enabled = toBool(body.enabled, Boolean(existing?.enabled))
  const allowSelfSigned = toBool(body.allow_self_signed, Boolean(existing?.allow_self_signed))

  // Port: absent keeps what is stored (587 on a first save, matching the
  // column default). Anything supplied must be a real port — `Number('')` is 0
  // and `Number('smtp')` is NaN, so both are caught by the integer test rather
  // than reaching the column as a 0 that silently never connects.
  const rawPort = body.port
  const portMissing =
    rawPort === undefined
    || rawPort === null
    || (typeof rawPort === 'string' && rawPort.trim() === '')
  const port = portMissing
    ? (existing ? Number(existing.port) : 587)
    : Number(typeof rawPort === 'number' ? rawPort : String(rawPort).trim())

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json(
      { error: 'The port must be a whole number between 1 and 65535.', nothingChanged: true },
      { status: 400 },
    )
  }

  // ⛔ THE REQUIRED FIELDS ARE REQUIRED WHEN THE TRANSPORT IS SWITCHED ON, not
  // before. An admin fills this form in stages and tests it while it is still
  // disabled (see the test route), so refusing a half-filled draft would make
  // that impossible. Turning it ON is the moment the suite starts depending on
  // these values.
  if (enabled && host === '') {
    return NextResponse.json(
      { error: 'A mail server host is required before SMTP can be enabled.', nothingChanged: true },
      { status: 400 },
    )
  }
  if (enabled && fromEmail === '') {
    return NextResponse.json(
      { error: 'A From address is required before SMTP can be enabled.', nothingChanged: true },
      { status: 400 },
    )
  }
  // Checked whenever one is supplied at all, not only when enabled — a From
  // address with no `@` is a typo in every state, and catching it here is the
  // difference between a message now and a silent rejection by the relay weeks
  // later when the first alert fires.
  if (fromEmail !== '' && !fromEmail.includes('@')) {
    return NextResponse.json(
      { error: 'The From address must be an email address.', nothingChanged: true },
      { status: 400 },
    )
  }

  const storedPassword = typeof existing?.password === 'string' ? existing.password : ''
  const supplied = typeof body.password === 'string' ? body.password : ''
  // ⛔ NOT TRIMMED. A password may legitimately begin or end with a space, and
  // silently storing a different one than the admin typed produces an auth
  // failure nothing in this product can explain.
  const isNewPassword = supplied !== '' && supplied !== PASSWORD_PLACEHOLDER

  let passwordToStore = storedPassword
  if (isNewPassword) {
    try {
      passwordToStore = encryptCred(supplied)
    } catch (err) {
      // The detail goes to the server log; the caller gets the one sentence
      // that tells them what to do about it.
      console.error('[suite-smtp] the SMTP password could not be encrypted:', err)
      return NextResponse.json(
        {
          error:
            'The SMTP password cannot be stored because NEXTAUTH_SECRET is not set on this '
            + 'server. Nothing was saved. Set NEXTAUTH_SECRET (it is the suite SSO signing '
            + 'secret, shared by all four apps), restart NetVault, then save again.',
          nothingChanged: true,
          secret_configured: false,
        },
        { status: 503 },
      )
    }
  }

  try {
    if (existing) {
      await query(
        `UPDATE smtp_config
            SET host = $1, port = $2, secure = $3, username = $4, password = $5,
                from_email = $6, from_name = $7, enabled = $8, allow_self_signed = $9,
                updated_at = NOW()
          WHERE id = $10`,
        [
          host,
          port,
          secure,
          username,
          passwordToStore,
          fromEmail,
          fromName,
          enabled,
          allowSelfSigned,
          existing.id,
        ],
      )
    } else {
      await query(
        `INSERT INTO smtp_config
           (host, port, secure, username, password, from_email, from_name, enabled,
            allow_self_signed, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [host, port, secure, username, passwordToStore, fromEmail, fromName, enabled, allowSelfSigned],
      )
    }
  } catch (err) {
    console.error('[suite-smtp] PUT failed to save the configuration:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // ⛔ THE PASSWORD IS RECORDED AS AN EVENT, NEVER AS A VALUE — and the
  // redaction is done HERE, not left to lib/systemAudit.ts. That module's
  // `VALUE_NEVER_RECORDED` set is keyed on the SETTING NAME and lists only the
  // three Entra keys, deliberately ("the redaction is keyed on the setting, not
  // on the value's shape"). It has no rule for an `smtp:` key, so anything
  // passed below as `from`/`to` is written to `audit_log` verbatim — a table
  // the Audit Log page renders and the readonly diagnostic roles can read.
  // Passing either the plaintext or the ciphertext would undo this whole file
  // in one line. Presence and a CHANGE are what an auditor needs: "somebody
  // rotated the relay credential" is the event, the credential is not.
  //
  // Recorded AFTER the write, like /api/system/tls, and `existing` was read
  // BEFORE it, so the `from` values are genuinely the previous ones.
  const passwordFrom = storedPassword !== '' ? PRESENT : ABSENT
  const passwordTo = isNewPassword
    ? (storedPassword !== '' ? '(set — replaced)' : PRESENT)
    : passwordFrom

  await recordSystemChanges(
    g.actorId,
    [
      { key: 'host', from: existing?.host ?? null, to: host },
      { key: 'port', from: existing ? String(existing.port) : null, to: String(port) },
      { key: 'secure', from: existing ? String(Boolean(existing.secure)) : null, to: String(secure) },
      { key: 'username', from: existing?.username ?? null, to: username },
      { key: 'from_email', from: existing?.from_email ?? null, to: fromEmail },
      { key: 'from_name', from: existing?.from_name ?? null, to: fromName },
      { key: 'enabled', from: existing ? String(Boolean(existing.enabled)) : null, to: String(enabled) },
      {
        key: 'allow_self_signed',
        from: existing ? String(Boolean(existing.allow_self_signed)) : null,
        to: String(allowSelfSigned),
      },
      { key: 'password', from: passwordFrom, to: passwordTo },
    ],
    'smtp',
  )

  return NextResponse.json({ success: true })
}
