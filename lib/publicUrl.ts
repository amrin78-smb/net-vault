// ⛔ `import type`: NextRequest is used ONLY as a type here. A plain named
// import survives Node's type stripping (which strips annotations but does no
// type-directed elision) and fails at runtime with "Cannot find module
// 'next/server'", making this module — and anything importing it —
// untestable under `node --test` while tsc and next build stay green. Same
// defect as lib/db.ts's PoolClient.
import type { NextRequest } from 'next/server'

// A cross-app redirect target used to be built by string-replacing a port onto
// NetVault's own (install-time, IP-baked) NEXTAUTH_URL — so it always pointed at
// the original install IP no matter what hostname the browser actually used (a
// customer's own local-DNS name, for instance). This derives the correct origin
// from the CURRENT request instead, so it follows whatever hostname is in use.
//
// x-forwarded-host/-proto are checked first for reverse-proxy deployments (the app
// itself would otherwise only see the proxy's own local host/scheme); a lightweight
// hostname-shape check guards against a malformed/unexpected header value before it's
// used to build a redirect URL. Falls back to today's exact behavior if the request
// doesn't carry a usable Host — never worse than the status quo.
/**
 * Just the keys these functions read.
 *
 * ⛔ NOT `NodeJS.ProcessEnv`, which this repo's types declare with a REQUIRED
 * `NODE_ENV` — so every test passing a small literal fails to compile, and the
 * workaround is a cast at each call site, which is how a test ends up asserting
 * against a shape the function never sees. `process.env` is assignable to this.
 */
export type EnvLike = Record<string, string | undefined>

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

/**
 * Hostnames that may legitimately appear in `x-forwarded-host`.
 *
 * ⛔ THIS IS THE `TRUST_PROXY_HEADERS` GAP CLAUDE.md HAS RECORDED AS KIV, AND
 * THE TLS TERMINATOR IS WHAT MAKES IT LIVE. Until now `x-forwarded-host` was
 * accepted on SHAPE alone, so anything that could reach the app directly could
 * set it and steer a redirect — including the `/api/sso/*` handoffs, which put
 * a short-lived SIGNED TOKEN in the redirect URL.
 *
 * ⛔ UNSET MEANS "BEHAVE EXACTLY AS BEFORE", AND THAT IS DELIBERATE RATHER THAN
 * LAZY. The tempting default — ignore proxy headers unless a proxy is declared
 * — is wrong here: behind the terminator the app is reached over plain HTTP on
 * loopback, so with `x-forwarded-proto` ignored it would conclude `http`, build
 * `http://` cross-app URLs over a genuinely TLS deployment, and bounce every
 * sign-in with no error anywhere. A hardening default that breaks sign-in the
 * moment TLS is switched on would simply be turned off again.
 *
 * So this narrows the hole when configured and changes nothing when not, and
 * the token-bearing path is closed separately and unconditionally by
 * `resolveCanonicalOrigin` below.
 */
function trustedForwardHosts(env: EnvLike = process.env): string[] | null {
  const raw = (env.TRUST_PROXY_HEADERS || '').trim()
  if (!raw) return null
  const hosts = raw
    .split(',')
    .map((h) => h.trim().split(':')[0].toLowerCase())
    .filter((h) => h !== '')
  return hosts.length > 0 ? hosts : null
}

/**
 * @param env injectable so the allow-list is testable without mutating the
 *   process environment — these are authorization-adjacent decisions and a test
 *   that has to set `process.env` leaks into every other test in the file.
 */
export function resolveOrigin(
  req: NextRequest,
  port: number | null,
  legacyFallback: string,
  env: EnvLike = process.env,
): string {
  const allowed = trustedForwardHosts(env)
  const forwardedHost = req.headers.get('x-forwarded-host')
  const ownHost = req.headers.get('host')

  // ⛔ When an allow-list IS configured, a forwarded host that is not on it is
  // DISCARDED rather than refused — we fall back to the request's own Host,
  // which is what the app would have seen without a proxy. Refusing outright
  // would turn a misconfigured allow-list into an outage on every page that
  // builds a cross-app link.
  const useForwarded =
    forwardedHost != null &&
    (allowed === null || allowed.includes(forwardedHost.split(':')[0].trim().toLowerCase()))

  const rawHost = (useForwarded ? forwardedHost : ownHost) || ''
  const hostname = rawHost.split(':')[0].trim()
  const proto = (req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '') || 'http')
    .split(',')[0]
    .trim()

  // ⛔ `port: null` MEANS "KEEP THE PORT WE WERE REACHED ON", NOT "NO PORT".
  // It used to mean the latter, and that made every no-session SSO handoff
  // redirect to a dead address. MEASURED on production 2026-11-07:
  //
  //   GET https://nocvault.thaiunion.com:3000/api/sso/spanvault   (no cookie)
  //     -> 307 https://nocvault.thaiunion.com/login?callbackUrl=...
  //   https://nocvault.thaiunion.com:443/login -> no response
  //   http://nocvault.thaiunion.com:80/login   -> no response
  //
  // `hostname` deliberately strips the inbound port so the host can be
  // shape-checked, and the old return then only re-added a port when the
  // CALLER named one. The three `ownOrigin` call sites in the SSO handoffs pass
  // null precisely because they want this host, this port — so they produced a
  // 443 URL on a suite whose public ports are 3000/3004/3006/3008 and which
  // listens on neither 443 nor 80.
  //
  // It survived because it is only reachable on the no-session and
  // access-denied branches: a signed-in user clicking a launcher tile never
  // builds ownOrigin. 1.63.0 cut the session from 30 days to 12 hours, which
  // turns "your session expired, click a tile" from rare into daily — so this
  // is a latent bug that release would have made routine.
  //
  // An explicitly requested port still wins, and the scheme's default port is
  // left off so an install genuinely fronted on 443 keeps a clean origin.
  const inboundPort = rawHost.includes(':') ? rawHost.split(':')[1].trim() : ''
  const keepInbound =
    /^\d{1,5}$/.test(inboundPort) &&
    !(proto === 'https' && inboundPort === '443') &&
    !(proto === 'http' && inboundPort === '80')
  const portPart = port ? `:${port}` : keepInbound ? `:${inboundPort}` : ''

  if (hostname && hostname.length <= 253 && HOSTNAME_RE.test(hostname) && (proto === 'http' || proto === 'https')) {
    return `${proto}://${hostname}${portPart}`
  }
  return legacyFallback
}

// ── REJECTED: pinning the SSO handoff to the configured console address ─────
//
// Considered and NOT built (2026-11-05). The idea: the `/api/sso/*` handoffs
// put a short-lived SIGNED JWT in a redirect URL, so the hostname in that URL
// decides who receives a credential — and deriving it from request headers
// means a header chooses that. Pinning it to `NEXTAUTH_URL` would remove the
// header from the decision entirely.
//
// ⛔ IT WAS REJECTED BECAUSE IT REINTRODUCES THE EXACT BUG THIS FILE EXISTS TO
// FIX. `NEXTAUTH_URL` is only trustworthy once an operator has SET it; on every
// install that has not yet used Settings → Console address it is still the
// install-time baked IP, which is what made every cross-app redirect point at
// an unreachable address in the first place (see the header comment). The
// hardening would have been correct on a configured install and a regression on
// all the others, with no way for the code to tell them apart.
//
// ⛔ And the risk it closes is thinner than it first looks: these routes require
// a valid session (`getToken`), and a browser never sends `x-forwarded-host` —
// so steering the redirect means making the request yourself, which means
// already holding the session whose token you would receive. The allow-list
// above is the part that was worth building, because it is opt-in and cannot
// regress an install that does not configure it.
//
// If this is revisited, the precondition is a way to distinguish "an operator
// declared this console's address" from "the installer wrote a default" —
// a separate explicit key, not an inference about NEXTAUTH_URL's contents.

export const SIBLING_PORTS = { logvault: 3004, ddivault: 3006, spanvault: 3008 } as const
