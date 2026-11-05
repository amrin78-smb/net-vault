//
// lib/consoleUrl.ts — what address is this console reached on?
//
// Ported from secvault/lib/consoleUrl.js, which earned every refusal in it the
// hard way. Read the reasoning before simplifying any of this.
//
// ⛔ WHY THIS IS NOT JUST A TEXT BOX. NextAuth builds its callback from
// NEXTAUTH_URL. Point it at a name the browser is not using and every sign-in
// bounces silently back to the login page — no error in the UI, none in the
// browser console, and the operator CANNOT LOG IN TO UNDO IT. The recovery is
// editing .env.local on the server and restarting the service.
//
// ⛔ AND IN NETVAULT IT IS WORSE THAN IT WAS IN SECVAULT, because NetVault is
// the HUB. NEXTAUTH_SECRET signs the cross-app SSO tokens for all four apps and
// every satellite redirect starts from a session established here, so a hub
// nobody can sign in to is a suite nobody can sign in to.
//
// That is the whole reason this file is pure and separately tested: the
// validation IS the safety mechanism, not decoration around a write. It does no
// file I/O and no HTTP — it decides, and the caller writes.
//
// ⛔ THE SCHEME MUST FOLLOW THE TRANSPORT. This refuses to CREATE the
// disagreement in the first place, which is the cheapest place to catch it: the
// alternative is finding out at the next sign-in, from a user who cannot sign
// in to report it.

import dns from 'node:dns'

const PORT_MIN = 1
const PORT_MAX = 65535

// ⛔ THE HUB'S PORT, AND IT IS 3000 HERE AND WAS 3010 IN SECVAULT — the one
// number that had to change in the port. It is used ONLY to build the example
// address in the advice messages; nothing validates against it, and a caller
// serving on another port passes `examplePort` rather than reading a wrong
// number back in an error.
export const DEFAULT_CONSOLE_PORT = 3000

// Deliberately narrow: a hostname or an IPv4 literal. Not a URL with a path,
// not a userinfo section, not an IPv6 literal — none of which NEXTAUTH_URL
// should carry here, and each of which would parse "successfully" into
// something that then fails only at sign-in.
const HOST_RE =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isIpv4(host: string): boolean {
  const m = IPV4_RE.exec(host)
  return !!m && m.slice(1).every((o) => o.length <= 3 && Number(o) >= 0 && Number(o) <= 255)
}

export const WARN_IP_ADDRESS =
  'This is an IP address. A certificate must carry it as an IP SAN, which public CAs do not '
  + 'issue for private addresses — a hostname is usually the better choice.'

export const WARN_LOOPBACK =
  'Only this machine can reach localhost. Anyone signing in from elsewhere will fail.'

export interface ConsoleUrlContext {
  // ⛔ TRI-STATE ON PURPOSE. true/false are the two known transports; UNDEFINED
  // means the caller could not determine which, and then the scheme-vs-transport
  // refusals below do not fire. Refusing on a transport we could not read would
  // be a failed read recorded as a fact, and the fact in question decides
  // whether anyone can sign in.
  tlsActive?: boolean
  // Only ever interpolated into the example in an advice message.
  examplePort?: number
}

export interface ConsoleUrlShape {
  ok: true
  url: string
  scheme: 'http' | 'https'
  host: string
  port: number | null
  warnings: string[]
}

export interface ConsoleUrlRefusal {
  ok: false
  error: string
}

export type ConsoleUrlResult = ConsoleUrlShape | ConsoleUrlRefusal

/**
 * Validate and normalise a proposed console address. Shape only — whether the
 * name points at this server is `hostPointsHere`'s question.
 */
export function validateConsoleUrl(input: unknown, ctx: ConsoleUrlContext = {}): ConsoleUrlResult {
  const raw = String(input == null ? '' : input).trim()
  if (!raw) return { ok: false, error: 'Enter the address this console is reached on.' }

  const example = `https://netvault.example.com:${ctx.examplePort ?? DEFAULT_CONSOLE_PORT}`

  // ⛔ THE COMMONEST MISTAKE IS OMITTING THE SCHEME, and it produces the most
  // confusing error: `new URL('host:3000')` parses "host" as the SCHEME and
  // SUCCEEDS, so the operator is told their own hostname is an unsupported
  // protocol. Caught BEFORE parsing, where the advice can be useful. Moving
  // this below the `new URL()` call does not add a check, it replaces a correct
  // message with a nonsense one on the single most likely input.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    return { ok: false, error: `Include the scheme, for example ${example}` }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {
      ok: false,
      error: `That address could not be parsed. Check the host and port, for example ${example}`,
    }
  }

  const scheme = parsed.protocol.replace(':', '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, error: `Only http and https are supported, not "${scheme}".` }
  }

  // ⛔ A PATH IS SILENTLY FATAL. NextAuth appends /api/auth/... to this value,
  // so a trailing path segment produces callback URLs that 404 — and the only
  // symptom is that sign-in does not work.
  if (parsed.pathname && parsed.pathname !== '/') {
    return { ok: false, error: 'Give the address only — no path after the host and port.' }
  }
  // ⛔ A QUERY OR FRAGMENT SURVIVES INTO THE CALLBACK in the same way, and a
  // fragment never even reaches the server, so the failure has no server-side
  // trace at all.
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'Give the address only — no query string or fragment.' }
  }
  // ⛔ EMBEDDED CREDENTIALS are pasted in from a browser address bar more often
  // than you would think. They make a callback URL that fails sign-in, and they
  // would be written in cleartext into the file that holds every suite secret.
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Remove the username and password from the address.' }
  }

  const host = parsed.hostname
  if (!host) return { ok: false, error: 'The address has no host.' }
  if (!isIpv4(host) && !HOST_RE.test(host)) {
    return { ok: false, error: `"${host}" is not a valid hostname.` }
  }

  let port: number | null = null
  if (parsed.port !== '') {
    port = Number(parsed.port)
    if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
      return { ok: false, error: `Port ${parsed.port} is out of range.` }
    }
  }

  // ⛔ SCHEME vs TRANSPORT. This is the disagreement that breaks sign-in with no
  // visible error, and it is REFUSED rather than warned about: an operator who
  // is told "this may not work" and proceeds is locked out just as thoroughly.
  if (ctx.tlsActive === true && scheme === 'http') {
    return {
      ok: false,
      error: 'TLS is active on this server, so the address must be https:// — with http:// the '
        + 'sign-in cookie is issued for an origin the browser is not on, and every login silently fails.',
    }
  }
  if (ctx.tlsActive === false && scheme === 'https') {
    return {
      ok: false,
      error: 'TLS is NOT active on this server, so the address must be http:// — install a '
        + 'certificate first, then change this.',
    }
  }

  const warnings: string[] = []
  if (isIpv4(host)) warnings.push(WARN_IP_ADDRESS)
  if (host === 'localhost' || host === '127.0.0.1') warnings.push(WARN_LOOPBACK)

  return { ok: true, url: `${scheme}://${host}${port === null ? '' : `:${port}`}`, scheme, host, port, warnings }
}

export type LookupFn = (host: string) => Promise<Array<string | { address?: string | null }>>

export interface HostResolution {
  // We obtained at least one address for this host.
  resolved: boolean
  // ⛔ TRUE / FALSE / NULL, AND NULL IS NOT A SYNONYM FOR EITHER. See below.
  pointsHere: boolean | null
  addresses: string[]
  error?: string
}

export interface ResolveOptions {
  // This server's own addresses, as the caller enumerated them. MISSING or
  // EMPTY means the caller could not enumerate them — see the refusal below.
  localAddresses?: string[] | null
  // ⛔ INJECTABLE SO EVERY BRANCH IS REACHABLE FROM A TEST without a real
  // resolver, a real network, or a hostname that has to keep existing. Defaults
  // to node's own DNS.
  lookup?: LookupFn
}

const defaultLookup: LookupFn = (host) => dns.promises.lookup(host, { all: true })

/**
 * Does the proposed host actually point at this server?
 *
 * ⛔ THE LOCKOUT GUARD. Everything in `validateConsoleUrl` is shape; this is the
 * only check that can tell a name that exists from a name nobody has created
 * yet, and setting the second one is exactly how an administrator makes the hub
 * unreachable by the one person who could change it back.
 *
 * ⛔ IT FAILS OPEN ON A RESOLVER ERROR, AND SAYS SO. An internal DNS name may
 * resolve from every workstation and not from this host, and refusing a correct
 * address because OUR OWN resolver is unhappy is its own kind of lockout.
 *
 * ⛔ THREE OUTCOMES, AND THE THIRD IS THE MOST IMPORTANT THING IN THIS FILE:
 *   - `pointsHere: true`  — an address we resolved is one of ours.
 *   - `pointsHere: false` — we resolved it and it is somewhere else. A REAL
 *                           finding; the caller must demand confirmation.
 *   - `pointsHere: null`  — WE COULD NOT DETERMINE THIS. Neither a pass nor a
 *                           refusal. Collapsing it to `false` turns "we could
 *                           not check" into "this is wrong" and makes the
 *                           operator confirm their way past a question nobody
 *                           asked; collapsing it to `true` throws the guard
 *                           away. DO NOT COLLAPSE IT TO A BOOLEAN.
 *
 * Three distinct ways to land on `null`, kept apart because they tell the
 * operator different things: the resolver threw, the resolver answered with an
 * EMPTY list (a name that exists and has no address is not a name that points
 * elsewhere), and this server's own addresses are unknown.
 */
export async function hostPointsHere(host: string, opts: ResolveOptions = {}): Promise<HostResolution> {
  const lookup = opts.lookup ?? defaultLookup

  // ⛔ AN UNKNOWN SET OF LOCAL ADDRESSES IS `null`, NEVER AN EMPTY SET. With an
  // empty list every comparison below answers "no", so a caller whose interface
  // enumeration failed would send EVERY correct address to the confirmation
  // prompt — the guard would stop being evidence and become a rubber stamp
  // people learn to click through. Our own failed read, reported as a fact
  // about the operator's DNS.
  const local =
    Array.isArray(opts.localAddresses) && opts.localAddresses.filter(Boolean).length > 0
      ? opts.localAddresses.filter(Boolean)
      : null

  // ONE comparison site, so there is one place this decision can be read and
  // one place it can be got wrong.
  const compare = (addresses: string[]): boolean | null =>
    local === null ? null : addresses.some((a) => local.includes(a))

  const unknownLocal = local === null ? { error: "this server's own addresses are unknown" } : {}

  // An IPv4 literal needs no resolver: it IS its own address.
  if (isIpv4(host)) {
    return { resolved: true, pointsHere: compare([host]), addresses: [host], ...unknownLocal }
  }

  try {
    const records = await lookup(host)
    const addresses = (records || [])
      .map((r) => (typeof r === 'string' ? r : r?.address))
      .filter((a): a is string => typeof a === 'string' && a.length > 0)
    // ⛔ AN EMPTY ANSWER IS NOT AN ANSWER. `resolved: false`, `pointsHere: null`
    // — not `false`. "This name has no address" cannot support the claim "this
    // name belongs to another machine".
    if (addresses.length === 0) {
      return { resolved: false, pointsHere: null, addresses: [], error: 'no addresses' }
    }
    return { resolved: true, pointsHere: compare(addresses), addresses, ...unknownLocal }
  } catch (err) {
    return {
      resolved: false,
      pointsHere: null,
      addresses: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export const WARN_UNRESOLVED =
  'This address could not be checked against this server — it may be correct and resolvable only '
  + 'from your workstation. Confirm the name resolves to this server before relying on it; if it '
  + 'does not, nobody will be able to sign in.'

export const WARN_POINTS_ELSEWHERE =
  'Saved anyway: this name does not resolve to this server. If that is wrong, sign-in will fail '
  + 'for everyone and the fix is editing .env.local on the server.'

export const CONFIRM_POINTS_ELSEWHERE =
  'That name resolves to a different machine, not this server. If that is not deliberate, every '
  + 'sign-in will fail and nobody will be able to change it back from the console. Confirm to save it anyway.'

export interface ConsoleUrlDecisionContext extends ConsoleUrlContext, ResolveOptions {
  // The operator has read the lockout warning and asked for it anyway.
  confirmed?: boolean
}

export type ConsoleUrlDecision =
  | { decision: 'refuse'; error: string }
  | ({ decision: 'accept' | 'confirm'; reason?: string; resolution: HostResolution } & Omit<ConsoleUrlShape, 'ok'>)

/**
 * The whole decision, in one call: accept, refuse, or require confirmation.
 *
 * ⛔ THIS EXISTS SO THE ROUTE DOES NOT RE-DERIVE IT. A caller that reads
 * `pointsHere` itself is a second implementation of the lockout guard, and two
 * implementations of one judgement eventually disagree — with this one the
 * disagreement is "nobody can sign in". The route's whole job is to turn
 * `confirm` into HTTP 409 + `needsConfirmation` and `accept` into a write.
 *
 * ⛔ IT MAKES NO AUTHORISATION DECISION. Whether this caller may change the
 * console address is the route's business and is checked inline there, as every
 * other guard in this repo is.
 */
export async function decideConsoleUrl(
  input: unknown,
  ctx: ConsoleUrlDecisionContext = {},
): Promise<ConsoleUrlDecision> {
  const shape = validateConsoleUrl(input, ctx)
  if (!shape.ok) return { decision: 'refuse', error: shape.error }

  const { ok: _ok, ...accepted } = shape
  const resolution = await hostPointsHere(shape.host, ctx)
  const warnings = [...shape.warnings]

  // ⛔ THE THREE RESOLVER OUTCOMES BECOME THREE DIFFERENT DECISIONS, and that
  // mapping is the point of the tri-state. `null` ACCEPTS WITH A WARNING the
  // operator has to read — never a silent pass, and never the confirmation
  // prompt, which would claim we found something we did not.
  if (resolution.pointsHere === null) {
    warnings.push(WARN_UNRESOLVED)
    return { decision: 'accept', ...accepted, warnings, resolution }
  }

  if (resolution.pointsHere === false) {
    if (!ctx.confirmed) {
      return { decision: 'confirm', reason: CONFIRM_POINTS_ELSEWHERE, ...accepted, warnings, resolution }
    }
    // Confirmed, so it is saved — and the warning survives into the response,
    // because the next person to read Settings did not click the prompt.
    warnings.push(WARN_POINTS_ELSEWHERE)
    return { decision: 'accept', ...accepted, warnings, resolution }
  }

  return { decision: 'accept', ...accepted, warnings, resolution }
}
