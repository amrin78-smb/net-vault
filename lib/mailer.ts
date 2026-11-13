// NetVault — the NocVault suite's SMTP transport.
//
// This is the hub's FIRST and ONLY mail module: NetVault has never sent email
// (see docs/nocvault-smtp-centralization-plan.md §1), so nothing here is a port
// of existing hub behaviour. It is deliberately written as the corrected shape
// of the three satellite mailers (logvault/collector/emailer.js,
// ddivault/api/emailer.js, spanvault/api/reportScheduler.js), each of which grew
// independently and each of which carries at least one defect this module fixes
// by construction — see the ⛔ comments below. Phase 1 of the plan, §4.3.
//
// ⛔ NEVER use nodemailer's message-level `raw` option anywhere in this file, or
// in any caller that builds a message object for sendMail(). `raw` bypasses
// `disableFileAccess`/`disableUrlAccess` and is the whole of GHSA-p6gq-j5cr-w38f
// (the advisory that kept the suite pinned behind nodemailer 9). We are on 9.x,
// where the advisory is fixed, but the option still exists and still defeats
// those guards — the safe posture is simply never to reach for it. Everything
// this module sends is an { to, subject, html } object.
//
// ⛔ `type Transporter`, INLINE, NOT A PLAIN NAMED IMPORT — the same trap
// documented at the top of lib/db.ts. `tests/*.test.ts` run under `node --test`,
// whose native TypeScript stripping removes ANNOTATIONS ONLY and does no
// type-directed elision, so a plain named import of a type survives to runtime
// and throws "does not provide an export named ...". nodemailer's own default
// export is a real CommonJS value and imports fine; only the types must be
// inline. (Verified by running tests/mailer.test.ts, which imports this file.)
import nodemailer, { type Transporter } from 'nodemailer'

/**
 * One SMTP identity. `fromEmail`/`fromName` stay per-app even once the hub owns
 * the transport (plan §3) — "LogVault Alerts" vs "DDIVault Alerts" in an inbox
 * is a feature, not drift.
 */
export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  fromEmail: string
  fromName: string
  allowSelfSigned: boolean
}

/** The exact option object handed to `nodemailer.createTransport`. */
export interface TransportOptions {
  host: string
  port: number
  secure: boolean
  auth?: { user: string; pass: string }
  tls?: { rejectUnauthorized: false }
}

/**
 * Assemble the transport options. Exported (and pure) so the two decisions that
 * have no second chance at runtime — TLS verification and whether auth is sent
 * at all — are directly assertable in a test rather than buried inside a live
 * SMTP connection.
 */
export function transportOptions(cfg: SmtpConfig): TransportOptions {
  const opts: TransportOptions = {
    host: cfg.host,
    // ⛔ `secure` comes from the CONFIG FIELD, never derived from `port === 465`.
    // LogVault and SpanVault both derive it, and that derivation has no correct
    // answer for the most common on-premises case: a relay on port 25 or 2525
    // speaking STARTTLS. Derived, such a relay is forced to `secure: false` and
    // the upgrade is a matter of luck, while a TLS-wrapped listener on a
    // non-465 port is unreachable outright. DDIVault stores an explicit column
    // and is right; this field is that column.
    port: cfg.port,
    secure: !!cfg.secure,
  }

  // Attach `auth` ONLY for a non-empty username. An open relay on a LAN takes no
  // auth at all, and handing such a server `auth: { user: '', pass: '' }` makes
  // some of them reject the session outright rather than ignore it.
  if (cfg.username) {
    opts.auth = { user: cfg.username, pass: cfg.password }
  }

  // ⛔ TLS VERIFICATION IS ON BY DEFAULT AND TURNING IT OFF IS AN EXPLICIT,
  // PER-INSTALL CHOICE. DDIVault's buildTransport passes
  // `tls: { rejectUnauthorized: false }` unconditionally and invisibly — every
  // DDIVault install silently accepts any certificate from anything answering on
  // that host:port, with no setting, no warning and nothing in the UI to reveal
  // it (plan §2.5). Here the option is omitted entirely unless the operator has
  // ticked `allowSelfSigned`, so the default install verifies, and an install
  // that does not verify says so in its own configuration.
  if (cfg.allowSelfSigned === true) {
    opts.tls = { rejectUnauthorized: false }
  }

  return opts
}

/** `"Name" <email>` when a from-name is configured, else the bare address. */
export function fromHeader(cfg: SmtpConfig): string {
  const name = (cfg.fromName || '').trim()
  return name ? '"' + name + '" <' + cfg.fromEmail + '>' : cfg.fromEmail
}

// Characters a real SMTP error code can contain. Everything else is dropped
// before the code is shown — see the reasoning in mailErrorSummary.
const CODE_SAFE = /[^A-Za-z0-9_-]/g
const CODE_MAX = 16

/**
 * ⛔ THE ONLY ERROR TEXT THAT MAY LEAVE THIS PROCESS.
 *
 * nodemailer's `err.message` routinely embeds the SMTP host, the port, the
 * configured username and the mail server's verbatim auth rejection — e.g.
 * "Invalid login: 535 5.7.3 Authentication unsuccessful for
 * alerts@corp.example on smtp.corp.example:587". Returning that from an admin
 * "send test email" button turns the button into an internal port scanner and a
 * configuration oracle: point it at any host:port and read the infrastructure
 * back out of the error. This is a RECORDED bug, fixed in both LogVault and
 * SpanVault (spanvault/api/rbacScope.js's mailErrorSummary) and still open in
 * DDIVault (plan §2.5), which is why this module ships the clamp on day one
 * rather than waiting to be the fourth instance of the same leak.
 *
 * `code`/`responseCode` are what an operator actually triages on (EAUTH,
 * ECONNREFUSED, ETIMEDOUT, 535, 550) and carry no configuration of their own.
 * They are clamped to a short, code-shaped string — not because a real code is
 * ever long or exotic, but because this is the one value that crosses the
 * boundary, so it is filtered rather than trusted: anything host-shaped placed
 * in `.code` by a future library loses its dots, colons and '@' and cannot
 * reassemble into an address or a host:port on the far side.
 *
 * The full error goes to the server log instead — see sendMail.
 */
export function mailErrorSummary(e: unknown): string {
  const tail = ' — see the server log for detail.'
  if (!e || typeof e !== 'object') {
    // A string, a number, null, undefined: nothing structured to report. In
    // particular a THROWN STRING must never be echoed — it is exactly the kind
    // of value that holds a whole message.
    return 'Email delivery failed' + tail
  }

  const err = e as { code?: unknown; responseCode?: unknown }
  const raw = err.code ?? err.responseCode
  if (raw === null || raw === undefined) return 'Email delivery failed' + tail

  const code = String(raw).replace(CODE_SAFE, '').slice(0, CODE_MAX)
  if (!code) return 'Email delivery failed' + tail

  return 'Email delivery failed (' + code + ')' + tail
}

/** Minimal HTML escaping for any value interpolated into an email body. */
function esc(val: unknown): string {
  if (val === null || val === undefined) return ''
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The body of the "send test email" button.
 *
 * Mail clients have no CSS custom properties and frequently strip <style>
 * blocks, so this is an inline-styled table layout with LITERAL hex — the suite
 * navy #1a2744 header bar and the #C8102E accent, matching the branded bodies in
 * ddivault/api/emailer.js and logvault/collector/emailer.js. Do not "tokenize"
 * these colours: var(--navy) renders as nothing in Outlook.
 */
export function renderTestEmailHtml(hubName: string): string {
  const name = esc(hubName) || 'NocVault'
  return (
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">' +
    '<div style="background:#1a2744;padding:20px 24px;">' +
    '<span style="font-family:Inter,Arial,sans-serif;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">' +
    name +
    '</span>' +
    '<div style="height:3px;width:48px;background:#C8102E;margin-top:8px;border-radius:2px;"></div>' +
    '</div>' +
    '<div style="padding:24px;font-family:Inter,Arial,sans-serif;font-size:14px;color:#1a2744;">' +
    '<p style="margin:0 0 8px 0;font-weight:700;">SMTP test successful</p>' +
    '<p style="margin:0;color:#64748b;">' +
    'This message was sent by ' +
    name +
    ' to confirm the suite SMTP settings. If you received it, the configured mail server accepted mail from this install.' +
    '</p>' +
    '</div>' +
    '<div style="padding:16px 24px;border-top:1px solid #e2e8f0;background:#f4f6f9;">' +
    '<span style="font-family:Inter,Arial,sans-serif;font-size:12px;color:#64748b;">' +
    'NocVault suite notification &middot; sent from ' +
    name +
    '</span>' +
    '</div>' +
    '</div>'
  )
}

/**
 * Send one message.
 *
 * ⛔ NEVER THROWS. Every caller is a route handler or a scheduler, and the two
 * things it must not do are crash the process and hand the caller a nodemailer
 * message. The full error is logged server-side — that log is the detail the
 * returned summary points at, so do not remove it to quieten the output.
 */
export async function sendMail(
  cfg: SmtpConfig,
  msg: { to: string; subject: string; html: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const transport: Transporter = nodemailer.createTransport(transportOptions(cfg))
    await transport.sendMail({
      from: fromHeader(cfg),
      to: msg.to,
      subject: msg.subject,
      // `html` only — never `raw` (see the file header).
      html: msg.html,
    })
    return { ok: true }
  } catch (e) {
    console.error('[mailer] send failed:', e)
    return { ok: false, error: mailErrorSummary(e) }
  }
}
