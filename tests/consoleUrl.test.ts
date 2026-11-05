import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  validateConsoleUrl,
  hostPointsHere,
  decideConsoleUrl,
  isIpv4,
  DEFAULT_CONSOLE_PORT,
  WARN_IP_ADDRESS,
  WARN_LOOPBACK,
  WARN_UNRESOLVED,
  WARN_POINTS_ELSEWHERE,
  type LookupFn,
} from '../lib/consoleUrl.ts'

// ⛔ EVERY TEST HERE ASSERTS THE OUTCOME, NEVER THE MECHANISM. The whole file
// was mutation-verified: each refusal and each arm of the lockout guard was
// deleted or inverted in lib/consoleUrl.ts in turn, and each one had to take a
// named test down with it. A test that still passes with its guard removed is
// pinning the shape of the code rather than the behaviour an operator gets, and
// this module's behaviour is "can anyone sign in afterwards".
//
// ⛔ NO REAL HOSTNAME, ADDRESS OR CREDENTIAL APPEARS BELOW. Hostnames are
// example.com, addresses are RFC 5737 / RFC 1918 documentation ranges.

const OURS = ['192.0.2.10', '10.0.0.5']
const ELSEWHERE = ['198.51.100.7']

// A resolver that answers, for the branch under test, and nothing else.
function lookupReturning(addresses: string[]): LookupFn {
  return async () => addresses.map((address) => ({ address }))
}
const lookupOurs = lookupReturning(OURS.slice(0, 1))
const lookupElsewhere = lookupReturning(ELSEWHERE)

// ── Nothing typed ────────────────────────────────────────────────────────────

test('refuses an empty address', () => {
  for (const input of ['', '   ', null, undefined]) {
    const r = validateConsoleUrl(input)
    assert.equal(r.ok, false, `${JSON.stringify(input)} must be refused`)
  }
})

// ── REFUSAL: a missing scheme, caught BEFORE new URL() ───────────────────────
//
// ⛔ THE MESSAGE *IS* THE OUTCOME HERE, which is why this test asserts one.
// `new URL('netvault.example.com:3000')` SUCCEEDS — it reads the hostname as the
// protocol — so moving this check below the parse does not lose a refusal, it
// replaces useful advice with "Only http and https are supported, not
// netvault.example.com" on the single commonest typo. Both halves are asserted:
// the advice is present, and the hostname is not reported back as a protocol.

test('refuses a missing scheme with scheme advice, not an unsupported-protocol complaint', () => {
  const r = validateConsoleUrl('netvault.example.com:3000')
  assert.equal(r.ok, false)
  const err = (r as { error: string }).error
  assert.match(err, /Include the scheme/, 'the operator must be told to add the scheme')
  assert.doesNotMatch(
    err,
    /Only http and https are supported/,
    'the hostname must never be reported back as an unsupported protocol',
  )
  assert.ok(
    err.includes(`:${DEFAULT_CONSOLE_PORT}`),
    "the example must carry the hub's port so it can be copied",
  )
})

test('a host with no port and no scheme is still refused for the scheme', () => {
  const r = validateConsoleUrl('netvault.example.com')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /Include the scheme/)
})

// ── REFUSAL: a scheme we cannot serve ────────────────────────────────────────

test('refuses a scheme that is neither http nor https', () => {
  const r = validateConsoleUrl('ftp://netvault.example.com:3000')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /http and https/)
})

// ── REFUSAL: unparseable ─────────────────────────────────────────────────────

test('refuses an address the URL parser cannot read', () => {
  const r = validateConsoleUrl('https://[not-an-address')
  assert.equal(r.ok, false)
})

// ── REFUSAL: a trailing path ─────────────────────────────────────────────────

test('refuses a trailing path, which would 404 every callback', () => {
  const r = validateConsoleUrl('https://netvault.example.com:3000/netvault')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /no path/)
})

test('a bare trailing slash is NOT a path and is accepted, normalised away', () => {
  const r = validateConsoleUrl('https://netvault.example.com:3000/')
  assert.equal(r.ok, true)
  assert.equal((r as { url: string }).url, 'https://netvault.example.com:3000')
})

// ── REFUSAL: a query string or a fragment ────────────────────────────────────

test('refuses a query string', () => {
  const r = validateConsoleUrl('https://netvault.example.com:3000?tab=users')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /query string or fragment/)
})

test('refuses a fragment', () => {
  const r = validateConsoleUrl('https://netvault.example.com:3000#top')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /query string or fragment/)
})

// ── REFUSAL: embedded credentials ────────────────────────────────────────────

test('refuses embedded credentials', () => {
  const r = validateConsoleUrl('https://someone:placeholder@netvault.example.com:3000')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /username and password/)
})

test('refuses a username with no password just as firmly', () => {
  const r = validateConsoleUrl('https://someone@netvault.example.com:3000')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /username and password/)
})

// ── REFUSAL: not a hostname we can write ─────────────────────────────────────

test('refuses a hostname with an illegal character', () => {
  const r = validateConsoleUrl('https://net_vault.example.com:3000')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /not a valid hostname/)
})

test('refuses an IPv6 literal, which this field does not support', () => {
  const r = validateConsoleUrl('https://[2001:db8::1]:3000')
  assert.equal(r.ok, false)
})

// ── REFUSAL: a port outside the range ────────────────────────────────────────
//
// Port 0 is the reachable case: the WHATWG parser accepts it and rejects
// anything above 65535 itself, so a too-high port lands on the parse refusal
// above. Both are refusals — what matters is that neither is accepted.

test('refuses port 0', () => {
  const r = validateConsoleUrl('https://netvault.example.com:0')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /out of range/)
})

test('refuses a port above 65535 by some route, never accepting it', () => {
  assert.equal(validateConsoleUrl('https://netvault.example.com:70000').ok, false)
})

// ── REFUSAL: the scheme must follow the transport ────────────────────────────

test('refuses http:// while TLS is active', () => {
  const r = validateConsoleUrl('http://netvault.example.com:3000', { tlsActive: true })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /must be https/)
})

test('refuses https:// while TLS is NOT active', () => {
  const r = validateConsoleUrl('https://netvault.example.com:3000', { tlsActive: false })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /must be http/)
})

test('an agreeing scheme is accepted under each known transport', () => {
  assert.equal(validateConsoleUrl('https://netvault.example.com:3000', { tlsActive: true }).ok, true)
  assert.equal(validateConsoleUrl('http://netvault.example.com:3000', { tlsActive: false }).ok, true)
})

// ⛔ THE "WE COULD NOT DETERMINE THIS" CASE FOR THE TRANSPORT. An absent
// tlsActive is not `false`. Refusing https on a server whose transport we could
// not read would refuse the correct address on every TLS install where the
// probe failed — our failed read, charged to the operator.
test('an unknown transport refuses neither scheme', () => {
  assert.equal(validateConsoleUrl('https://netvault.example.com:3000').ok, true)
  assert.equal(validateConsoleUrl('http://netvault.example.com:3000').ok, true)
  assert.equal(validateConsoleUrl('https://netvault.example.com:3000', {}).ok, true)
})

// ── Normalisation and warnings ───────────────────────────────────────────────

test('the accepted value is normalised without inventing a port', () => {
  const r = validateConsoleUrl('HTTPS://NetVault.Example.com')
  assert.equal(r.ok, true)
  const ok = r as { url: string; scheme: string; host: string; port: number | null }
  assert.equal(ok.url, 'https://netvault.example.com')
  assert.equal(ok.port, null, 'an omitted port must stay omitted, never defaulted to the hub port')
  assert.equal(ok.scheme, 'https')
  assert.equal(ok.host, 'netvault.example.com')
})

test('an IP address is accepted and warned about, never refused', () => {
  const r = validateConsoleUrl('https://192.0.2.10:3000')
  assert.equal(r.ok, true)
  assert.ok((r as { warnings: string[] }).warnings.includes(WARN_IP_ADDRESS))
})

test('loopback is accepted and warned about, never refused', () => {
  for (const host of ['localhost', '127.0.0.1']) {
    const r = validateConsoleUrl(`http://${host}:3000`, { tlsActive: false })
    assert.equal(r.ok, true)
    assert.ok((r as { warnings: string[] }).warnings.includes(WARN_LOOPBACK), `${host} must warn`)
  }
})

test('a correct hostname carries no warnings', () => {
  const r = validateConsoleUrl('https://netvault.example.com:3000')
  assert.deepEqual((r as { warnings: string[] }).warnings, [])
})

test('isIpv4 accepts dotted quads and rejects out-of-range octets', () => {
  assert.equal(isIpv4('192.0.2.10'), true)
  assert.equal(isIpv4('10.0.0.5'), true)
  assert.equal(isIpv4('192.0.2.256'), false)
  assert.equal(isIpv4('192.0.2'), false)
  assert.equal(isIpv4('netvault.example.com'), false)
})

// ── hostPointsHere: the three resolver outcomes, kept apart ──────────────────

test('resolver outcome 1: an address of ours is a definite pass', async () => {
  const r = await hostPointsHere('netvault.example.com', { lookup: lookupOurs, localAddresses: OURS })
  assert.equal(r.pointsHere, true)
  assert.equal(r.resolved, true)
  assert.deepEqual(r.addresses, [OURS[0]])
})

test('resolver outcome 2: a resolved address that is not ours is a definite FALSE', async () => {
  const r = await hostPointsHere('elsewhere.example.com', { lookup: lookupElsewhere, localAddresses: OURS })
  assert.equal(r.pointsHere, false, 'a name resolving somewhere else is a real finding, not an unknown')
  assert.equal(r.resolved, true)
})

// ⛔ THE RESOLVER THREW. `null`, never `false` — an internal name may resolve
// from every workstation and not from this host.
test('resolver outcome 3a: a resolver error is null, not false, and carries its reason', async () => {
  const r = await hostPointsHere('netvault.example.com', {
    lookup: async () => {
      throw new Error('ENOTFOUND')
    },
    localAddresses: OURS,
  })
  assert.equal(r.pointsHere, null)
  assert.equal(r.resolved, false)
  assert.match(r.error ?? '', /ENOTFOUND/)
})

// ⛔ AN EMPTY ANSWER IS NOT AN ANSWER. A name with no address cannot support
// the claim that it belongs to another machine.
test('resolver outcome 3b: an empty answer is null, not false', async () => {
  const r = await hostPointsHere('netvault.example.com', { lookup: async () => [], localAddresses: OURS })
  assert.equal(r.pointsHere, null)
  assert.equal(r.resolved, false)
  assert.deepEqual(r.addresses, [])
})

// ⛔ AND THE THIRD WAY TO LAND ON null IS OUR OWN FAILURE, NOT DNS'S. With an
// empty local set every comparison answers "no", so this would send every
// correct address to the confirmation prompt and turn the lockout guard into a
// rubber stamp people learn to click through.
test('resolver outcome 3c: unknown local addresses are null, not false', async () => {
  for (const localAddresses of [undefined, null, [] as string[]]) {
    const r = await hostPointsHere('netvault.example.com', { lookup: lookupElsewhere, localAddresses })
    assert.equal(r.pointsHere, null, `localAddresses=${JSON.stringify(localAddresses)} must be unknown`)
  }
})

test('an IPv4 literal is compared without a resolver at all', async () => {
  const boom: LookupFn = async () => {
    throw new Error('the resolver must not be consulted for a literal')
  }
  const mine = await hostPointsHere('192.0.2.10', { lookup: boom, localAddresses: OURS })
  assert.equal(mine.pointsHere, true)
  const theirs = await hostPointsHere('198.51.100.7', { lookup: boom, localAddresses: OURS })
  assert.equal(theirs.pointsHere, false)
  const unknown = await hostPointsHere('192.0.2.10', { lookup: boom, localAddresses: [] })
  assert.equal(unknown.pointsHere, null)
})

test('a resolver answering bare strings is read the same as one answering records', async () => {
  const r = await hostPointsHere('netvault.example.com', {
    lookup: async () => [OURS[1]],
    localAddresses: OURS,
  })
  assert.equal(r.pointsHere, true)
})

test('empty and malformed records are dropped rather than counted as addresses', async () => {
  const r = await hostPointsHere('netvault.example.com', {
    lookup: async () => [{ address: null }, { address: '' }, ''],
    localAddresses: OURS,
  })
  assert.equal(r.pointsHere, null, 'nothing usable came back, so this is unknown')
  assert.equal(r.resolved, false)
})

// ── decideConsoleUrl: accept / refuse / confirm ──────────────────────────────

test('a shape refusal short-circuits before any resolution', async () => {
  let consulted = false
  const d = await decideConsoleUrl('https://netvault.example.com:3000/path', {
    localAddresses: OURS,
    lookup: async () => {
      consulted = true
      return []
    },
  })
  assert.equal(d.decision, 'refuse')
  assert.equal(consulted, false, 'a malformed address must not cost a DNS lookup')
})

test('a name that points here is accepted outright', async () => {
  const d = await decideConsoleUrl('https://netvault.example.com:3000', {
    lookup: lookupOurs,
    localAddresses: OURS,
  })
  assert.equal(d.decision, 'accept')
  const a = d as { url: string; warnings: string[] }
  assert.equal(a.url, 'https://netvault.example.com:3000')
  assert.deepEqual(a.warnings, [], 'nothing to warn about when the name is ours')
})

// ⛔ THE LOCKOUT GUARD, FROM THE CALLER'S SIDE. The route turns this into
// HTTP 409 + needsConfirmation. Accepting it silently is the one way to make
// the hub unreachable by the person who made the typo.
test('THE LOCKOUT GUARD: a name resolving elsewhere requires confirmation, not acceptance', async () => {
  const d = await decideConsoleUrl('https://elsewhere.example.com:3000', {
    lookup: lookupElsewhere,
    localAddresses: OURS,
  })
  assert.equal(d.decision, 'confirm', 'this must never be accepted without the operator saying so')
  assert.notEqual(d.decision, 'accept')
  const c = d as { reason?: string; resolution: { pointsHere: boolean | null } }
  assert.ok(c.reason && c.reason.length > 0, 'the prompt must say why')
  assert.equal(c.resolution.pointsHere, false)
})

test('confirmation path two: an explicitly confirmed mismatch is saved, and still warns', async () => {
  const d = await decideConsoleUrl('https://elsewhere.example.com:3000', {
    lookup: lookupElsewhere,
    localAddresses: OURS,
    confirmed: true,
  })
  assert.equal(d.decision, 'accept')
  assert.ok(
    (d as { warnings: string[] }).warnings.includes(WARN_POINTS_ELSEWHERE),
    'the warning must survive into the saved state — the next reader never saw the prompt',
  )
})

// ⛔ "WE COULD NOT DETERMINE THIS" AT THE DECISION LEVEL: an unresolvable host
// is NEITHER a pass nor a refusal nor a confirmation prompt. Accepted, with a
// warning the operator has to read.
test('an unresolvable host is accepted with a warning, never refused and never a prompt', async () => {
  const d = await decideConsoleUrl('https://internal.example.com:3000', {
    lookup: async () => {
      throw new Error('EAI_AGAIN')
    },
    localAddresses: OURS,
  })
  assert.equal(d.decision, 'accept', 'our own resolver being unhappy must not lock the operator out')
  assert.notEqual(d.decision, 'confirm', 'we found nothing, so we must not claim we found a mismatch')
  assert.ok((d as { warnings: string[] }).warnings.includes(WARN_UNRESOLVED))
  assert.equal((d as { resolution: { pointsHere: boolean | null } }).resolution.pointsHere, null)
})

test('a host that resolves to nothing is accepted with the same warning', async () => {
  const d = await decideConsoleUrl('https://internal.example.com:3000', {
    lookup: async () => [],
    localAddresses: OURS,
  })
  assert.equal(d.decision, 'accept')
  assert.ok((d as { warnings: string[] }).warnings.includes(WARN_UNRESOLVED))
})

test('unknown local addresses are accepted with the same warning, not a prompt', async () => {
  const d = await decideConsoleUrl('https://elsewhere.example.com:3000', { lookup: lookupElsewhere })
  assert.equal(d.decision, 'accept')
  assert.notEqual(d.decision, 'confirm')
  assert.ok((d as { warnings: string[] }).warnings.includes(WARN_UNRESOLVED))
})

test('shape warnings survive the decision rather than being replaced by it', async () => {
  const d = await decideConsoleUrl('https://192.0.2.10:3000', {
    lookup: lookupOurs,
    localAddresses: OURS,
  })
  assert.equal(d.decision, 'accept')
  assert.ok((d as { warnings: string[] }).warnings.includes(WARN_IP_ADDRESS))
})

test('a transport disagreement is refused before the lockout guard can accept it', async () => {
  const d = await decideConsoleUrl('http://netvault.example.com:3000', {
    tlsActive: true,
    lookup: lookupOurs,
    localAddresses: OURS,
  })
  assert.equal(d.decision, 'refuse')
})

test('the decision carries no `ok` field that could be read as a verdict', async () => {
  const d = await decideConsoleUrl('https://netvault.example.com:3000', {
    lookup: lookupOurs,
    localAddresses: OURS,
  })
  assert.equal('ok' in d, false, 'there is exactly one verdict field and it is `decision`')
})
