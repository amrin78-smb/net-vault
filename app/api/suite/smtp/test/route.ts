import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'

import { query } from '@/lib/db.ts'
import { credSecretConfigured, decryptCred } from '@/lib/credStore.ts'
import { mailErrorSummary, renderTestEmailHtml, sendMail, type SmtpConfig } from '@/lib/mailer.ts'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit.ts'

export const dynamic = 'force-dynamic'

// Settings → Notifications → "Send test message".
//
// ⛔ THIS ENDPOINT IS A PORT SCANNER WEARING A SETTINGS BUTTON, AND THAT IS WHY
// IT IS THROTTLED. Strip the wording away and it is "connect from the NetVault
// server to a host and port of my choosing and tell me what happened" — run in
// a loop, the shape and timing of the answers map every reachable service on
// the server's own network, from inside the firewall. super_admin gating makes
// that an insider move rather than an anonymous one; it does not make it cheap.
// The 5-per-10-minutes window is far more than a real admin needs (configure,
// test, fix a typo, test again) and far less than a sweep requires. It is keyed
// on the SOURCE IP, not the user, so one compromised session cannot simply fan
// out. `lib/rateLimit.ts` fails open by design, so a bug in the limiter can
// only ever lose the throttle — never block a legitimate test.
//
// ⛔ THE ERROR RETURNED HERE IS SANITIZED, ALWAYS. DDIVault's equivalent
// (`POST /api/smtp/test` → `emailer.sendTestEmail`'s `{ ok: false, error:
// err.message }`) hands the caller nodemailer's raw message, which routinely
// embeds the host, the port, the configured username and the relay's verbatim
// auth rejection — a known defect being fixed separately, and the surviving
// instance of a class LogVault and SpanVault both already closed. NetVault
// ships with `mailErrorSummary()` from day one so the class never exists here:
// every path below returns its output, and the detail goes to `console.error`
// where an operator with server access — and only them — can read it.
//
// ⛔ IT TESTS WHAT IS SAVED, AND IT WORKS WHILE `enabled` IS FALSE. Two
// deliberate choices that go together. Testing the SAVED row means the thing
// being proven is the thing the suite will actually use — a test that accepted
// a configuration in the request body would happily prove a relay that is not
// the one on file, and would also be a way to post a password to a route whose
// whole job is to connect somewhere with it. Ignoring `enabled` means the
// order of operations is save → test → switch on, rather than asking an admin
// to turn on suite-wide alert mail before they have any evidence it works.

const TEST_RATE_LIMIT = { maxAttempts: 5, windowMs: 10 * 60 * 1000 }

// Deliberately looser than the usual "looks like an address" regex: no dot is
// required in the domain, because an internal relay routinely accepts
// `postmaster@mailhost`. It rejects whitespace, a missing `@` and a second one
// — the typos that produce a confusing relay-side rejection rather than a
// useful message here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/

type SmtpRow = {
  host: string | null
  port: number | string | null
  secure: boolean | null
  username: string | null
  password: string | null
  from_email: string | null
  from_name: string | null
  allow_self_signed: boolean | null
}

/** The hub's display name, for the body of the test message. Branding only. */
async function hubName(): Promise<string> {
  try {
    const res = await query("SELECT value FROM app_settings WHERE key = 'app_name'")
    const name = (res.rows[0] as { value?: string } | undefined)?.value
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'NetVault'
  } catch {
    // A missing branding row must never be the reason a test email fails.
    return 'NetVault'
  }
}

export async function POST(req: NextRequest) {
  // The gate first: it costs no database round trip (the session is a signed
  // cookie), so an unauthenticated flood is refused before it can consume
  // anybody's rate-limit bucket.
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = ((session as { user?: { role?: string } }).user || {}).role
  if (role !== 'super_admin') {
    return NextResponse.json(
      { error: 'Sending a test message through the suite relay requires a super admin.' },
      { status: 403 },
    )
  }

  const ip = getClientIp(req)
  const rl = checkRateLimit(`suite-smtp-test:${ip}`, TEST_RATE_LIMIT)
  if (rl.limited) {
    return NextResponse.json(
      { ok: false, error: 'Too many test messages — try again in a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const body = (await req.json().catch(() => ({}))) as { to?: unknown }
  const to = typeof body.to === 'string' ? body.to.trim() : ''
  if (to === '' || !EMAIL_RE.test(to)) {
    return NextResponse.json(
      { ok: false, error: 'Enter the email address the test message should be sent to.' },
      { status: 400 },
    )
  }

  try {
    const res = await query('SELECT * FROM smtp_config ORDER BY id LIMIT 1')
    const row = (res.rows[0] as SmtpRow | undefined) || null

    // ⛔ SAVE FIRST, THEN TEST — and say so plainly. Without this the admin who
    // fills the form and presses Test straight away gets a connection error
    // about an empty host and reasonably concludes their relay is unreachable.
    if (!row || !row.host || String(row.host).trim() === '') {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Save the SMTP configuration first — a test message is sent using the saved '
            + 'settings, not the ones currently in the form.',
        },
        { status: 400 },
      )
    }

    const stored = typeof row.password === 'string' ? row.password : ''
    // `decryptCred` returns '' on ANY failure and never throws, so an empty
    // result is ambiguous on its own: no password was ever saved, or one was
    // saved and can no longer be read. The second case is a real, nameable
    // condition — NEXTAUTH_SECRET missing or rotated since the save — and
    // letting it fall through would produce an authentication failure that
    // blames the relay for a local problem.
    const password = stored === '' ? '' : decryptCred(stored)
    if (stored !== '' && password === '') {
      console.error(
        '[suite-smtp-test] the stored SMTP password could not be decrypted'
        + ` (NEXTAUTH_SECRET configured: ${credSecretConfigured()}).`,
      )
      return NextResponse.json(
        {
          ok: false,
          error: credSecretConfigured()
            ? 'The saved SMTP password could not be read. It was most likely encrypted with a '
              + 'different NEXTAUTH_SECRET than this server now has — re-enter the password and '
              + 'save, then test again.'
            : 'The saved SMTP password cannot be read because NEXTAUTH_SECRET is not set on this '
              + 'server. Set it (it is the suite SSO signing secret), restart NetVault, re-enter '
              + 'the password and save, then test again.',
        },
        { status: 503 },
      )
    }

    const cfg: SmtpConfig = {
      host: String(row.host).trim(),
      port: Number(row.port) || 587,
      secure: Boolean(row.secure),
      username: row.username || '',
      password,
      fromEmail: row.from_email || '',
      fromName: row.from_name || 'NocVault',
      allowSelfSigned: Boolean(row.allow_self_signed),
    }

    const name = await hubName()
    const result = await sendMail(cfg, {
      to,
      subject: `${name} — SMTP test message`,
      html: renderTestEmailHtml(name),
    })

    if (result.ok) return NextResponse.json({ ok: true })

    // ⛔ 200, NOT 5xx, AND THE MESSAGE IS `sendMail`'s OWN. The request was
    // well-formed, authorized and fully processed; what failed is the relay,
    // which is the ANSWER this endpoint exists to give, not an error in giving
    // it. `result.error` has already been through `mailErrorSummary` — code
    // and response code only, never the host, port or username.
    return NextResponse.json({ ok: false, error: result.error })
  } catch (err) {
    // ⛔ `mailErrorSummary`, NEVER `err.message`. This catch covers the
    // database read as well as anything `sendMail` lets escape, and an
    // unsanitized message here would reopen the exact leak the header warns
    // about — by a path nobody would think to check.
    console.error('[suite-smtp-test] test message failed:', err)
    return NextResponse.json({ ok: false, error: mailErrorSummary(err) }, { status: 500 })
  }
}
