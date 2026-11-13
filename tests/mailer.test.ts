import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  fromHeader,
  mailErrorSummary,
  renderTestEmailHtml,
  transportOptions,
  type SmtpConfig,
} from '../lib/mailer.ts'

// Importing lib/mailer.ts pulls `nodemailer` in at runtime. That is deliberate
// and it works: nodemailer 9.x is CommonJS with a real default export, so Node's
// type stripping has nothing to elide (the `Transporter` type beside it is an
// INLINE type import for exactly that reason — see lib/db.ts's header). The pure
// functions therefore did NOT have to be split away from the transport, and they
// are tested against the same module the route will import, not a copy of it.

/** A complete, realistic config. Tests override only what they are about. */
function cfg(over: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: 'smtp.corp.example',
    port: 587,
    secure: false,
    username: 'alerts@corp.example',
    password: 'hunter2',
    fromEmail: 'noreply@corp.example',
    fromName: 'NocVault Hub',
    allowSelfSigned: false,
    ...over,
  }
}

// ── 1. the disclosure control ───────────────────────────────────────────────
//
// ⛔ THIS IS THE CONTROL, NOT A FORMALITY. The entire reason lib/mailer.ts
// returns a code-derived string instead of `err.message` is that nodemailer's
// message embeds the host, the port, the configured username and the mail
// server's verbatim rejection — and the caller of this module is an admin "send
// test email" button, i.e. an authenticated user who can aim it at any host:port
// and read the answer. LogVault and SpanVault each shipped that leak and each
// had to fix it; DDIVault still has it. If this test is ever relaxed to let the
// message through "for better diagnostics", that bug is back for a fourth time.

const SECRETS = ['smtp.corp.example', '587', 'alerts@corp.example', 'hunter2']

/** Assert the summary is usable AND leaks nothing from `secrets`/the message. */
function assertNoDisclosure(summary: string, message: string, secrets = SECRETS) {
  assert.equal(typeof summary, 'string')
  assert.ok(summary.length > 0, 'an operator must still get something to act on')
  assert.ok(
    summary.includes('see the server log for detail'),
    'the summary must point at where the real detail lives',
  )
  for (const s of secrets) {
    assert.ok(
      !summary.includes(s),
      'summary leaked ' + JSON.stringify(s) + ': ' + JSON.stringify(summary),
    )
  }
  assert.ok(!summary.includes(message), 'the raw nodemailer message must never appear')
  // Nothing address- or host:port-shaped may survive, whatever its source.
  assert.ok(!/@/.test(summary), 'no "@" — an address cannot be reassembled from this')
  assert.ok(!/:\d/.test(summary), 'no host:port pair')
}

test('⛔ mailErrorSummary discloses neither host, port, username nor the server message', () => {
  // The shapes nodemailer really produces, with their real message text.
  const authMsg =
    'Invalid login: 535 5.7.3 Authentication unsuccessful for alerts@corp.example on smtp.corp.example:587'
  const authErr = Object.assign(new Error(authMsg), {
    code: 'EAUTH',
    responseCode: 535,
    response: '535 5.7.3 Authentication unsuccessful',
    command: 'AUTH LOGIN',
  })
  assertNoDisclosure(mailErrorSummary(authErr), authMsg)
  assert.ok(mailErrorSummary(authErr).includes('EAUTH'), 'the triage code is the point')

  // responseCode only — no `code`.
  const relayMsg = 'Message failed: 550 5.7.1 Relay access denied for alerts@corp.example'
  const relayErr = Object.assign(new Error(relayMsg), { responseCode: 550 })
  assertNoDisclosure(mailErrorSummary(relayErr), relayMsg)
  assert.ok(mailErrorSummary(relayErr).includes('550'))

  // Neither code nor responseCode — the generic branch still may not echo.
  const bareMsg = 'connect ECONNREFUSED smtp.corp.example:587 (user alerts@corp.example)'
  assertNoDisclosure(mailErrorSummary(new Error(bareMsg)), bareMsg)

  // A thrown STRING. `typeof e === 'object'` is false, so there is no code to
  // read — and the string itself is exactly the kind of value that holds the
  // whole message, so it must not be reflected.
  const strMsg = 'getaddrinfo ENOTFOUND smtp.corp.example — auth as alerts@corp.example:587'
  assertNoDisclosure(mailErrorSummary(strMsg), strMsg)

  // null / undefined must not throw and must not produce "undefined".
  for (const e of [null, undefined]) {
    const s = mailErrorSummary(e)
    assert.ok(s.length > 0)
    assert.ok(!/undefined|null/.test(s), 'no stringified nothing: ' + s)
    assert.ok(s.includes('see the server log for detail'))
  }
})

test('⛔ a host-shaped value planted in .code cannot reassemble', () => {
  // Defence in depth: the code is the ONE value that crosses the boundary, so it
  // is filtered and clamped rather than trusted. A library that one day puts a
  // target in `.code` must not hand it back out intact.
  const s = mailErrorSummary({ code: 'smtp.corp.example:587/alerts@corp.example' })
  assertNoDisclosure(s, 'smtp.corp.example:587')
  assert.ok(!s.includes('smtp.corp.example'), s)
})

// ── 2. fromHeader ───────────────────────────────────────────────────────────

test('fromHeader uses the display name when there is one, and the bare address otherwise', () => {
  assert.equal(fromHeader(cfg()), '"NocVault Hub" <noreply@corp.example>')
  assert.equal(fromHeader(cfg({ fromName: '' })), 'noreply@corp.example')
  // Whitespace is not a name — it would ship as an empty quoted display name.
  assert.equal(fromHeader(cfg({ fromName: '   ' })), 'noreply@corp.example')
})

// ── 3. escaping in the test-email body ──────────────────────────────────────

test('renderTestEmailHtml escapes the value it interpolates', () => {
  const html = renderTestEmailHtml('<script>alert(1)</script> Tom & Jerry')
  assert.ok(!html.includes('<script>'), 'a raw tag must never reach a mail client')
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('Tom &amp; Jerry'))
  // The branding this body exists to carry, as literal hex — mail clients have
  // no CSS variables, so a token here would render as nothing.
  assert.ok(html.includes('#1a2744'), 'navy header bar')
  assert.ok(html.includes('#C8102E'), 'red accent')
  assert.ok(renderTestEmailHtml('').includes('NocVault'), 'an empty name still brands')
})

// ── 4. the allowSelfSigned default ──────────────────────────────────────────

test('⛔ TLS verification stays ON unless allowSelfSigned is explicitly true', () => {
  // DDIVault disables certificate verification unconditionally and invisibly.
  // The default here must be the verifying one, and it must be expressed by
  // OMITTING the option — passing `rejectUnauthorized: true` would look the same
  // in a happy-path test while silently overriding a future secure default.
  for (const over of [
    {},
    { allowSelfSigned: false },
    { secure: true },
    { port: 465, secure: true },
    { username: '' },
  ] as Partial<SmtpConfig>[]) {
    const opts = transportOptions(cfg(over))
    assert.equal(opts.tls, undefined, 'no tls option at all: ' + JSON.stringify(over))
    assert.ok(!('tls' in opts), 'the key must be absent, not undefined-valued')
  }

  // Truthy-but-not-true must NOT disable verification either: this comes from a
  // DB column and a JSON body, where 'false' and 1 both arrive sooner or later.
  for (const bad of ['false', 'true', 1, 'yes'] as unknown[]) {
    const opts = transportOptions(cfg({ allowSelfSigned: bad as boolean }))
    assert.equal(opts.tls, undefined, 'only a real `true` opts out: ' + JSON.stringify(bad))
  }

  // The explicit opt-in, and only it, turns verification off.
  const relaxed = transportOptions(cfg({ allowSelfSigned: true }))
  assert.deepEqual(relaxed.tls, { rejectUnauthorized: false })
})

test('secure is the configured field, never derived from the port', () => {
  // A STARTTLS relay on 25/2525 and a TLS-wrapped listener on a non-465 port are
  // both expressible here; under LogVault's and SpanVault's `port === 465`
  // derivation neither one has a correct setting.
  assert.equal(transportOptions(cfg({ port: 25, secure: false })).secure, false)
  assert.equal(transportOptions(cfg({ port: 2525, secure: true })).secure, true)
  assert.equal(transportOptions(cfg({ port: 465, secure: false })).secure, false)
  assert.equal(transportOptions(cfg({ port: 465, secure: true })).secure, true)
})

test('auth is attached only for a non-empty username', () => {
  // An open relay on a LAN takes no auth, and `auth: { user: '', pass: '' }`
  // makes some servers reject the session outright.
  const anon = transportOptions(cfg({ username: '', password: '' }))
  assert.equal(anon.auth, undefined)
  assert.ok(!('auth' in anon), 'the key must be absent, not undefined-valued')

  assert.deepEqual(transportOptions(cfg()).auth, {
    user: 'alerts@corp.example',
    pass: 'hunter2',
  })
  // A username with no password is still auth — some relays take an empty pass.
  assert.deepEqual(transportOptions(cfg({ password: '' })).auth, {
    user: 'alerts@corp.example',
    pass: '',
  })
})

test('host and port are passed through untouched', () => {
  const opts = transportOptions(cfg({ host: 'mail.internal', port: 2525 }))
  assert.equal(opts.host, 'mail.internal')
  assert.equal(opts.port, 2525)
})
