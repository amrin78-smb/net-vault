import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  toneStyle,
  transportPresentation,
  shadowPresentation,
  worstShadow,
  takesEffectPresentation,
  formatDaysRemaining,
  chainPresentation,
  savedVsRunning,
  pendingFieldSummary,
  filePresentation,
  fileRoleLabel,
  base64Payload,
  redirectUriPresentation,
  EXPIRY_DANGER_DAYS,
  EXPIRY_WARN_DAYS,
} from '../components/settings/systemPanelHelpers.ts'

// ⛔ EVERY TEST HERE ASSERTS AN OUTCOME AN OPERATOR WOULD SEE, NEVER THE SHAPE
// OF THE CODE. The whole file was mutation-verified: each guard in
// `components/settings/systemPanelHelpers.ts` was deleted or inverted in turn
// and had to take a NAMED test down with it. The failures these guards prevent
// are all the same failure — a three-state fact flattened into two, so the
// panel reads "fine" for a state that is not.
//
// ⛔ NO REAL HOSTNAME, ADDRESS, TENANT, CLIENT ID OR CERTIFICATE APPEARS BELOW.

// ─── tone tokens ─────────────────────────────────────────────────────────────

test('every tone resolves to design tokens, never to a literal colour', () => {
  for (const tone of ['ok', 'info', 'warn', 'danger', 'neutral'] as const) {
    const s = toneStyle(tone)
    for (const v of [s.background, s.color, s.borderColor]) {
      assert.ok(v.startsWith('var(--'), `${tone} produced a non-token value: ${v}`)
      assert.ok(!/#[0-9a-f]{3,8}/i.test(v), `${tone} hardcoded a hex: ${v}`)
    }
  }
})

test('a tinted tone pairs its background with the matching -fg text colour', () => {
  // ⛔ --tint-warn text on --text-secondary is unreadable in dark mode; the two
  // halves of a tint pair must come from the same pair.
  const warn = toneStyle('warn')
  assert.equal(warn.background, 'var(--tint-warn)')
  assert.equal(warn.color, 'var(--tint-warn-fg)')
})

// ─── the three transport states ──────────────────────────────────────────────

test('transport: active reads as working', () => {
  const p = transportPresentation('active', { httpsPort: 3000, httpPort: 3080 })
  assert.equal(p.tone, 'ok')
  assert.equal(p.loud, false)
  assert.equal(p.normal, false)
  assert.match(p.headline, /3000/)
})

test('transport: disabled is NOT an error and is not loud', () => {
  // ⛔ "No certificate configured" is how the whole suite has shipped. Rendered
  // as a fault it becomes an alarm every operator learns to ignore — and the
  // one they then ignore is `failed`.
  const p = transportPresentation('disabled', { httpsPort: 3000 })
  assert.notEqual(p.tone, 'danger')
  assert.equal(p.loud, false)
  assert.equal(p.normal, true)
  assert.match(p.headline, /normal state/i)
})

test('transport: failed is loud, danger, and never reads like disabled', () => {
  // ⛔ THE CENTRAL GUARD OF THE CERTIFICATE PANEL. The operator asked for TLS
  // and is being served plaintext; `failed` and `disabled` must not produce the
  // same tone, the same loudness or the same sentence.
  const failed = transportPresentation('failed', { httpsPort: 3000, error: 'Certificate file is empty.' })
  const disabled = transportPresentation('disabled', { httpsPort: 3000 })
  assert.equal(failed.tone, 'danger')
  assert.equal(failed.loud, true)
  assert.equal(failed.normal, false)
  assert.notEqual(failed.tone, disabled.tone)
  assert.notEqual(failed.loud, disabled.loud)
  assert.notEqual(failed.headline, disabled.headline)
  assert.match(failed.headline, /Certificate file is empty\./)
})

test('transport: an absent or unrecognised status is unchecked, never healthy', () => {
  for (const status of [undefined, null, '', 'enabled', 'ACTIVE']) {
    const p = transportPresentation(status)
    assert.notEqual(p.tone, 'ok', `${String(status)} was reported as healthy`)
    assert.equal(p.loud, false)
    assert.equal(p.normal, false)
    assert.match(p.headline, /unknown|not a clean bill/i)
  }
})

// ─── the three shadow states ─────────────────────────────────────────────────

test('shadow: clear is the only state the panel may stay silent about', () => {
  const p = shadowPresentation({ state: 'clear' }, 'NEXTAUTH_URL')
  assert.equal(p.state, 'clear')
  assert.equal(p.show, false)
  assert.equal(p.tone, 'ok')
})

test('shadow: shadowed is a warning that the save is durable but inert', () => {
  const p = shadowPresentation({ state: 'shadowed', serviceName: 'NetVault' }, 'ENTRA_TENANT_ID')
  assert.equal(p.state, 'shadowed')
  assert.equal(p.show, true)
  assert.notEqual(p.tone, 'ok')
  assert.match(p.detail, /cannot take effect/i)
  assert.match(p.detail, /ENTRA_TENANT_ID/)
})

test('shadow: unknown is shown and is NOT rendered as clear', () => {
  // ⛔ "We did not check" is not "nothing is pinned". Collapsing the two
  // promises the operator a change that may silently never take effect.
  const unknown = shadowPresentation({ state: 'unknown', reason: 'not running on Windows' }, 'TLS_CERT_PATH')
  const clear = shadowPresentation({ state: 'clear' }, 'TLS_CERT_PATH')
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.show, true)
  assert.notEqual(unknown.tone, clear.tone)
  assert.notEqual(unknown.state, clear.state)
  assert.match(unknown.detail, /not a clean bill of health/i)
  assert.match(unknown.detail, /not running on Windows/)
})

test('shadow: a missing or unrecognised verdict fails closed to unknown', () => {
  for (const v of [undefined, null, {}, { state: 'ok' }, { state: 'CLEAR' }]) {
    const p = shadowPresentation(v as never, 'TLS_KEY_PATH')
    assert.equal(p.state, 'unknown', `${JSON.stringify(v)} was not treated as unchecked`)
    assert.equal(p.show, true)
  }
})

test('worstShadow: shadowed beats unknown beats clear', () => {
  // ⛔ Summarising a shadowed key beside a clear one as "clear" is how an inert
  // save gets reported as a working one.
  assert.equal(worstShadow([{ state: 'clear' }, { state: 'clear' }]), 'clear')
  assert.equal(worstShadow([{ state: 'clear' }, { state: 'unknown', reason: 'x' }]), 'unknown')
  assert.equal(worstShadow([{ state: 'unknown', reason: 'x' }, { state: 'shadowed' }]), 'shadowed')
  assert.equal(worstShadow([{ state: 'shadowed' }, { state: 'clear' }]), 'shadowed')
  // A verdict that never arrived is unchecked, not clear.
  assert.equal(worstShadow([undefined, { state: 'clear' }]), 'unknown')
  assert.equal(worstShadow([]), 'clear')
})

test('takesEffectOnRestart: null is unchecked, not a promise that it will apply', () => {
  const yes = takesEffectPresentation(true, 'NetVault')
  const no = takesEffectPresentation(false, 'NetVault')
  const unknown = takesEffectPresentation(null, 'NetVault')
  assert.equal(yes.tone, 'info')
  assert.match(yes.text, /Restart the NetVault service/)
  assert.equal(no.tone, 'warn')
  assert.match(no.text, /will NOT apply/)
  assert.notEqual(unknown.text, yes.text)
  assert.notEqual(unknown.tone, 'ok')
  assert.match(unknown.text, /could not be determined/i)
})

// ─── expiry ──────────────────────────────────────────────────────────────────

test('days remaining: an expired certificate says so and is danger', () => {
  const p = formatDaysRemaining(-3)
  assert.equal(p.expired, true)
  assert.equal(p.tone, 'danger')
  assert.match(p.text, /Expired 3 days ago/)
  assert.equal(formatDaysRemaining(-1).text, 'Expired 1 day ago')
})

test('days remaining: zero is today, not "unknown" and not expired', () => {
  // ⛔ `!days` would swallow 0 into the unknown branch — the one day where the
  // certificate is about to stop working.
  const p = formatDaysRemaining(0)
  assert.equal(p.text, 'Expires today')
  assert.equal(p.tone, 'danger')
  assert.equal(p.expired, false)
})

test('days remaining: the two thresholds escalate and the far future is fine', () => {
  assert.equal(formatDaysRemaining(EXPIRY_DANGER_DAYS).tone, 'danger')
  assert.equal(formatDaysRemaining(EXPIRY_DANGER_DAYS + 1).tone, 'warn')
  assert.equal(formatDaysRemaining(EXPIRY_WARN_DAYS).tone, 'warn')
  assert.equal(formatDaysRemaining(EXPIRY_WARN_DAYS + 1).tone, 'ok')
  assert.equal(formatDaysRemaining(365).text, 'Expires in 365 days')
  assert.equal(formatDaysRemaining(1).text, 'Expires in 1 day')
})

test('days remaining: an unreadable expiry is a warning, never "fine"', () => {
  for (const v of [undefined, null, NaN, Infinity]) {
    const p = formatDaysRemaining(v as never)
    assert.equal(p.text, 'Expiry unknown')
    assert.notEqual(p.tone, 'ok')
    assert.equal(p.expired, false)
  }
})

test('chain: a leaf-only certificate is a warning, a full chain is not', () => {
  // ⛔ Leaf-only validates in a browser that has the intermediate cached and
  // fails in strict clients — an intermittent failure blamed on the client.
  const leaf = chainPresentation(1)
  assert.equal(leaf.tone, 'warn')
  assert.match(leaf.text, /no intermediate/i)
  assert.equal(chainPresentation(3).tone, 'ok')
  assert.match(chainPresentation(3).text, /leaf \+ 2 chain/)
  assert.equal(chainPresentation(0).tone, 'warn')
  assert.equal(chainPresentation(undefined).tone, 'warn')
})

// ─── saved vs running ────────────────────────────────────────────────────────

test('saved vs running: a difference in VALUE is reported, not a difference in configured-ness', () => {
  const differing = savedVsRunning('http://a.example.com:3000', 'http://b.example.com:3000')
  assert.equal(differing.differs, true)
  assert.equal(differing.saved, 'http://a.example.com:3000')
  assert.equal(differing.running, 'http://b.example.com:3000')

  const same = savedVsRunning('http://a.example.com:3000', 'http://a.example.com:3000')
  assert.equal(same.differs, false)
})

test('saved vs running: whitespace and absence both normalise to null', () => {
  const p = savedVsRunning('   ', null)
  assert.equal(p.saved, null)
  assert.equal(p.running, null)
  assert.equal(p.differs, false)
  assert.equal(p.empty, true)
  // One set and one not is a difference.
  assert.equal(savedVsRunning('http://a.example.com:3000', null).differs, true)
})

test('pending fields: the API’s own labels are used verbatim', () => {
  // ⛔ The secret is compared on the SERVER so that only its LABEL travels. A
  // label invented in the browser would be a guess about the one field we are
  // never allowed to see.
  const one = pendingFieldSummary(['Client secret'], 'NetVault')
  assert.ok(one)
  assert.match(one, /Client secret is saved but not yet in force/)
  assert.match(one, /Restart the NetVault service/)

  const three = pendingFieldSummary(['Directory (tenant) ID', 'Application (client) ID', 'Client secret'])
  assert.ok(three)
  assert.match(three, /Directory \(tenant\) ID, Application \(client\) ID and Client secret are saved/)
})

test('pending fields: nothing pending produces nothing on screen', () => {
  assert.equal(pendingFieldSummary([]), null)
  assert.equal(pendingFieldSummary(undefined), null)
  assert.equal(pendingFieldSummary(null), null)
  assert.equal(pendingFieldSummary('Client secret' as never), null)
  // A list of blanks is still nothing pending — not an empty banner.
  assert.equal(pendingFieldSummary(['', '   ', null, undefined]), null)
})

// ─── per-file state ──────────────────────────────────────────────────────────

test('file state: an unreadable file is NOT reported as unset', () => {
  // ⛔ "Not set" on a file we could not read invites an administrator to retype
  // a value that is already there, into a file whose contents are unknown.
  const unreadable = filePresentation({ path: '/x/.env', exists: true, value: null, error: 'EACCES: permission denied' })
  const unset = filePresentation({ path: '/x/.env', exists: true, value: null })
  assert.equal(unreadable.tone, 'danger')
  assert.match(unreadable.label, /could not be read/i)
  assert.equal(unreadable.detail, 'EACCES: permission denied')
  assert.notEqual(unreadable.label, unset.label)
  assert.notEqual(unreadable.tone, unset.tone)
})

test('file state: missing, unset and set are three different answers', () => {
  const missing = filePresentation({ path: '/x/.env', exists: false, value: null })
  assert.equal(missing.tone, 'neutral')
  assert.match(missing.label, /not present/i)

  const unset = filePresentation({ path: '/x/.env', exists: true, value: '' })
  assert.equal(unset.tone, 'warn')
  assert.match(unset.label, /not set/i)

  const set = filePresentation({ path: '/x/.env', exists: true, value: 'http://netvault.example.com:3000' })
  assert.equal(set.tone, 'ok')
  assert.equal(set.label, 'http://netvault.example.com:3000')

  assert.equal(filePresentation(null).tone, 'warn')
})

test('file roles are named the way the route names them', () => {
  assert.equal(fileRoleLabel('deploy-source'), 'Deploy source')
  assert.equal(fileRoleLabel('running'), 'Running file')
  assert.equal(fileRoleLabel(undefined), 'File')
})

// ─── uploads ─────────────────────────────────────────────────────────────────

test('base64 payload: the data-URL prefix is stripped', () => {
  // ⛔ The route does Buffer.from(v,'base64'), which does NOT throw on the
  // prefix — it decodes garbage, and the .pfx then fails complaining about the
  // password, sending the operator to fix the one thing that was right.
  assert.equal(base64Payload('data:application/x-pkcs12;base64,QUJD'), 'QUJD')
  assert.equal(base64Payload('data:;base64,QUJD'), 'QUJD')
  // Already-bare payloads and empty input survive untouched.
  assert.equal(base64Payload('QUJD'), 'QUJD')
  assert.equal(base64Payload(''), '')
  assert.equal(base64Payload(null), '')
  // A bare payload that happens to contain a comma is not a data URL.
  assert.equal(base64Payload('QUJD,XYZ'), 'QUJD,XYZ')
})

// ─── the redirect URI pair ───────────────────────────────────────────────────

test('redirect URI: one value when nothing is pending', () => {
  const p = redirectUriPresentation('http://netvault.example.com:3000/api/auth/callback/entra', null)
  assert.equal(p.current, 'http://netvault.example.com:3000/api/auth/callback/entra')
  assert.equal(p.afterRestart, null)
  assert.equal(p.bothRequired, false)
  assert.equal(p.note, null)
})

test('redirect URI: both are shown when a console-address change is pending', () => {
  // ⛔ Registering only one breaks sign-in on one side of the restart, and the
  // failure happens on Microsoft's side — nothing reaches this server's logs.
  const p = redirectUriPresentation(
    'http://netvault.example.com:3000/api/auth/callback/entra',
    'https://netvault.example.com:3000/api/auth/callback/entra',
  )
  assert.equal(p.bothRequired, true)
  assert.equal(p.afterRestart, 'https://netvault.example.com:3000/api/auth/callback/entra')
  assert.ok(p.note)
  assert.match(p.note, /BOTH/)
})

test('redirect URI: an identical "after restart" value is not a second URI', () => {
  const same = 'http://netvault.example.com:3000/api/auth/callback/entra'
  const p = redirectUriPresentation(same, same)
  assert.equal(p.bothRequired, false)
  assert.equal(p.afterRestart, null)
  assert.equal(p.note, null)
})

test('redirect URI: an unset console address produces no URI at all', () => {
  const p = redirectUriPresentation(null, 'http://netvault.example.com:3000/api/auth/callback/entra')
  assert.equal(p.current, null)
  // ⛔ Without a current URI there is nothing to register "as well as", so the
  // second one must not be promoted into the only one shown.
  assert.equal(p.bothRequired, false)
  assert.equal(p.afterRestart, null)
})

// ─── the terminator frame (1.60.1) ──────────────────────────────────────────
//
// ⛔ BEHIND THE FRONT DOOR, EVERY PORT NUMBER MEANS SOMETHING ELSE.
// `resolveTlsConfig` reads `HTTPS_PORT || PORT` from THIS process, and after
// the TLS cutover that is the console's LOOPBACK port, where it serves PLAIN
// HTTP. Reported unchanged the panel said "Serving HTTPS on port 13000" — the
// app is not serving HTTPS, and 13000 is not an address anybody connects to.
// Observed on production 2026-11-06.

test('fronted: the sentence names the PUBLIC port and the front door', () => {
  const p = transportPresentation('active', { httpsPort: 13000, publicPort: 3000, fronted: true })
  assert.equal(p.tone, 'ok')
  assert.equal(p.label, 'HTTPS active')
  assert.match(p.headline, /port 3000/)
  assert.match(p.headline, /NocVault-Tls/)
  assert.ok(!/Serving HTTPS on port 13000/.test(p.headline), 'must never claim HTTPS on the loopback port')
})

test('fronted: it says the console itself is plain HTTP on the loopback', () => {
  const p = transportPresentation('active', { httpsPort: 13000, publicPort: 3000, fronted: true })
  assert.match(p.headline, /127\.0\.0\.1:13000/)
  assert.match(p.headline, /plain HTTP/i)
  assert.match(p.headline, /not reachable\s+directly/i)
})

test('fronted: it does not promise a dedicated redirect port that is closed', () => {
  // The cutover leaves 3080/3084/3086/3088 CLOSED and answers plain HTTP on
  // the public port itself with a 301, so "plain HTTP on 3080 redirects here"
  // was false on every cut-over install.
  const p = transportPresentation('active', { httpsPort: 13000, httpPort: 3080, publicPort: 3000, fronted: true })
  assert.ok(!/3080/.test(p.headline), 'must not name the closed redirect port')
  assert.match(p.headline, /redirect/i)
})

test('not fronted: the original sentence is unchanged', () => {
  const p = transportPresentation('active', { httpsPort: 3000, httpPort: 3080 })
  assert.match(p.headline, /Serving HTTPS on port 3000/)
  assert.match(p.headline, /plain HTTP on 3080 redirects here/)
})

test('fronted does not rescue a failed or disabled transport', () => {
  // `fronted` changes how `active` READS. It must not turn a broken transport
  // into a working-looking one.
  assert.equal(transportPresentation('failed', { fronted: true, publicPort: 3000 }).tone, 'danger')
  assert.equal(transportPresentation('failed', { fronted: true, publicPort: 3000 }).loud, true)
  assert.equal(transportPresentation('disabled', { fronted: true, publicPort: 3000 }).normal, true)
})
