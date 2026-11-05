//
// lib/tlsConfig.ts — resolves the suite's TLS configuration and says,
// unambiguously, which of THREE transport states we are in.
//
// Pure apart from reading the two files it is pointed at, so a test can drive
// every branch. It binds no port and starts no server: the listener is a
// separate concern and this is only the decision layer in front of it.
//
// Ported from SecVault's `lib/tlsConfig.js` (its v2.112.0 TLS work), which is
// where every ⛔ below was learned. Keep the reasoning with the code.
//
// ⛔ THREE STATES, NOT TWO, and conflating any two of them is the bug this file
// exists to prevent:
//
//   'active'      certs configured and loaded — HTTPS is really on
//   'disabled'    no certs configured — plain HTTP, as the whole NocVault suite
//                 (netvault 3000, logvault 3004, ddivault 3006, spanvault 3008)
//                 has shipped for its entire life. NOT an error.
//   'failed'      certs WERE configured and could not be loaded
//
// ⛔ 'failed' MUST NEVER LOOK LIKE 'disabled'. The operator asked for TLS and is
// not getting it; degrading quietly to plaintext while the settings still name
// a `TLS_CERT_PATH` is this codebase's failed-read-recorded-as-a-fact rule
// applied to the transport — its most dangerous form, because the reader's
// conclusion ("we're encrypted") is the exact opposite of the truth. So
// `describeTlsStatus` says so in plain words, and callers are expected to log
// it at error level on every start and surface it in health/Settings.
//
// ⛔ WHY IT DEGRADES RATHER THAN REFUSING TO START. On an infrastructure
// console an outage has its own cost: nobody can see the fleet. A broken cert
// file turning into a dead console is a worse day than a loud, visible "TLS is
// configured but not active". The choice is deliberate — and it is only safe
// BECAUSE 'failed' is never silent. Do not make it quiet.
//
// ⛔ NOTHING IS HARDCODED TO ONE APP. SecVault owned its own single listener on
// 3010/3080. Here TLS is terminated by ONE shared listener in front of all four
// consoles, so this module is instantiated once per upstream app: the ports come
// from the environment, and the per-app fallbacks come from the caller via
// `defaults`. The built-in default is the hub (netvault, 3000) because that is
// the one app that is always present.
//
//   HTTPS_PORT           the port the TLS listener answers on (falls back to
//                        PORT, which is what NSSM already pins for netvault)
//   HTTP_REDIRECT_PORT   the plain-HTTP port that only ever 301s to https
//   TLS_CERT_PATH        certificate (PEM) — already a managed key in
//   TLS_KEY_PATH         private key (PEM)    `lib/envTargets.ts`
//
// This module makes NO authorization decision. NetVault has no `lib/rbac.ts` —
// authorization is inline per route — and whoever is allowed to upload a
// certificate is that route's problem, not this file's.

import fs from 'node:fs'
import tls from 'node:tls'

/** The hub's port. A per-app instantiation passes its own via `defaults`. */
export const DEFAULT_HTTPS_PORT = 3000
/** Plain HTTP, redirect only. Shared by the one terminator, so not per-app. */
export const DEFAULT_HTTP_REDIRECT_PORT = 3080

export type TlsStatus = 'active' | 'disabled' | 'failed'

export interface TlsConfig {
  /** ⛔ Three values. There is no boolean here, deliberately. */
  status: TlsStatus
  httpsPort: number
  httpPort: number
  /** Loaded material — populated only when `status === 'active'`. */
  cert: Buffer | null
  key: Buffer | null
  /** What the environment asked for, whether or not it worked. */
  certPath: string | null
  keyPath: string | null
  /** Non-null if and only if `status === 'failed'`. */
  error: string | null
}

/**
 * The file reads and the secure-context build, injectable together.
 *
 * ⛔ Both default to the REAL stack (`node:fs`, `node:tls`), because defaulting
 * to the real stack is the entire point of the load check below. Injection
 * exists so tests can reach every failure branch without real key material.
 */
export interface TlsFsImpl {
  readFileSync?: (path: string) => Buffer
  createSecureContext?: (options: { cert: Buffer; key: Buffer }) => unknown
}

/** Per-app port fallbacks, for a terminator standing in front of four apps. */
export interface TlsPortDefaults {
  httpsPort?: number
  httpPort?: number
}

/** The environment keys this module reads. Everything is optional. */
export interface TlsEnv {
  HTTPS_PORT?: string
  PORT?: string
  HTTP_REDIRECT_PORT?: string
  TLS_CERT_PATH?: string
  TLS_KEY_PATH?: string
  [key: string]: string | undefined
}

/**
 * A port from the environment, or the fallback.
 *
 * ⛔ NEVER NaN AND NEVER 0. `parseInt('')` is NaN and `listen(NaN)` is not an
 * error — node quietly binds an ephemeral port, so the console comes up on a
 * port nobody can guess and the failure looks like a network problem. A 0 is
 * the same trap spelled explicitly. Anything that is not a usable port number
 * is treated as absent.
 */
export function portFrom(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value == null ? '' : value).trim(), 10)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

/**
 * Decide the TLS state from an environment.
 *
 * @param env       defaults to `process.env`
 * @param fsImpl    file reads + secure-context builder; defaults to the real stack
 * @param defaults  per-app port fallbacks for a shared terminator
 */
export function resolveTlsConfig(
  env?: TlsEnv,
  fsImpl?: TlsFsImpl,
  defaults?: TlsPortDefaults,
): TlsConfig {
  const e: TlsEnv = env || (process.env as TlsEnv)
  const readFileSync = fsImpl?.readFileSync || fs.readFileSync
  const makeContext = fsImpl?.createSecureContext || tls.createSecureContext

  const httpsPort = portFrom(
    e.HTTPS_PORT || e.PORT,
    portFrom(defaults?.httpsPort, DEFAULT_HTTPS_PORT),
  )
  const httpPort = portFrom(
    e.HTTP_REDIRECT_PORT,
    portFrom(defaults?.httpPort, DEFAULT_HTTP_REDIRECT_PORT),
  )

  const certPath = (e.TLS_CERT_PATH || '').trim() || null
  const keyPath = (e.TLS_KEY_PATH || '').trim() || null

  const base = {
    httpsPort,
    httpPort,
    cert: null,
    key: null,
    certPath,
    keyPath,
    error: null,
  } satisfies Omit<TlsConfig, 'status'>

  // ⛔ BOTH OR NEITHER. One path set alone is a half-finished configuration,
  // and calling it "disabled" would silently ignore an operator who has
  // clearly started turning TLS on. It is a failure and is reported as one.
  if (!certPath && !keyPath) return { ...base, status: 'disabled' }
  if (!certPath || !keyPath) {
    return {
      ...base,
      status: 'failed',
      error:
        `TLS is half-configured: ${certPath ? 'TLS_KEY_PATH' : 'TLS_CERT_PATH'} is not set. ` +
        'Set both, or neither.',
    }
  }

  try {
    const cert = readFileSync(certPath)
    const key = readFileSync(keyPath)

    // ⛔ An EMPTY file reads without throwing — `fs` is perfectly happy with
    // zero bytes — so nothing above this line notices it. Left to fall
    // through, it is reported by the secure-context build below as
    // ERR_OSSL_PEM_NO_START_LINE, which is the SAME error a DER `.cer` or a
    // truncated download produces and so points the operator at the wrong fix
    // ("the file is the wrong format") for a file that simply has no content;
    // before that build existed it got all the way to the handshake, where
    // there is no legible error at all. Caught here, where the file can still
    // be named.
    if (!cert || cert.length === 0) {
      return { ...base, status: 'failed', error: `Certificate file is empty: ${certPath}` }
    }
    if (!key || key.length === 0) {
      return { ...base, status: 'failed', error: `Private key file is empty: ${keyPath}` }
    }

    // ⛔ ACTUALLY LOAD THE MATERIAL. Everything above proves only that two
    // non-empty files exist, and `active` used to mean exactly that — while
    // `https.createServer()` builds its SecureContext SYNCHRONOUSLY and THROWS
    // on anything OpenSSL cannot parse. That throw escapes startup, the process
    // exits non-zero, and the service manager restarts it. Forever.
    //
    // So in SecVault the one corruption class that degraded safely was the one
    // that cannot happen quietly (an empty file), and the classes that actually
    // happen in the field — a DER `.cer` saved over the `.crt`, a truncated
    // download, a restored `.bak` pair whose halves do not match — took the
    // console down permanently, on a reboot, with no rollback in the path
    // because a reboot never runs the updater.
    //
    // That inverted the stated rule: a broken certificate must DEGRADE to HTTP,
    // and degrading is only safe because `failed` is loud. Building the context
    // HERE is what makes `active` mean "TLS will actually load".
    try {
      makeContext({ cert, key })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      const message = err instanceof Error ? err.message : String(err)
      return {
        ...base,
        status: 'failed',
        // ⛔ The OpenSSL code is the useful half — ERR_OSSL_PEM_NO_START_LINE
        // means "not PEM at all" (so: wrong file, or DER), and
        // ERR_OSSL_X509_KEY_VALUES_MISMATCH means "the key does not belong to
        // this certificate" (so: a half-restored pair). They point at different
        // fixes, so the code is KEPT rather than flattened into the useless
        // "certificate invalid".
        error: `The certificate and key could not be loaded (${code || 'unknown error'}): ${message}`,
      }
    }

    return { ...base, status: 'active', cert, key }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ...base,
      status: 'failed',
      error: `Could not read the TLS certificate or key: ${message}`,
    }
  }
}

/**
 * The one-line summary for a startup log or a health response.
 *
 * ⛔ 'failed' READS AS A PROBLEM IN PLAIN WORDS. A reader skimming a startup
 * log must not be able to mistake it for a normal state, so the three strings
 * share no interchangeable wording: `disabled` says "not configured",
 * `failed` says "CONFIGURED BUT NOT ACTIVE" and carries the reason.
 */
export function describeTlsStatus(config: TlsConfig | null | undefined): string {
  if (!config) return 'TLS: unknown'
  if (config.status === 'active') {
    return `TLS: ACTIVE on port ${config.httpsPort} (HTTP redirect on ${config.httpPort})`
  }
  if (config.status === 'disabled') {
    return `TLS: not configured — serving plain HTTP on port ${config.httpsPort}`
  }
  return `TLS: **CONFIGURED BUT NOT ACTIVE** — ${config.error} — serving plain HTTP on port ${config.httpsPort}`
}

/**
 * The public origin, for NEXTAUTH_URL sanity checks and links.
 *
 * ⛔ EXISTS BECAUSE A SCHEME MISMATCH BREAKS SIGN-IN SILENTLY. NextAuth builds
 * its callback URL from NEXTAUTH_URL; if that still says `http://` after TLS is
 * switched on, the cookie is issued for an origin the browser is not on and the
 * user is bounced straight back to the login page — with no error in the
 * browser, in the app log, or anywhere else.
 */
export function expectedOrigin(config: TlsConfig | null | undefined, host?: string): string {
  const scheme = config && config.status === 'active' ? 'https' : 'http'
  const port = config ? config.httpsPort : DEFAULT_HTTPS_PORT
  return `${scheme}://${host || 'localhost'}:${port}`
}

/**
 * Does NEXTAUTH_URL agree with the transport we are actually serving?
 *
 * ⛔ Compared against `status === 'active'`, not against "certs are configured".
 * In `failed` we are serving plaintext, so an `https://` NEXTAUTH_URL is just
 * as broken there as it is in `disabled` — and that is precisely the case an
 * operator lands in after uploading a bad certificate.
 *
 * @returns the problem in one sentence, or null when the two agree.
 */
export function nextAuthUrlMismatch(
  config: TlsConfig | null | undefined,
  nextAuthUrl?: string | null,
): string | null {
  if (!config || !nextAuthUrl) return null
  const isHttps = /^https:/i.test(String(nextAuthUrl).trim())
  if (config.status === 'active' && !isHttps) {
    return 'NEXTAUTH_URL is http:// but TLS is active. Sign-in will fail: update it to https://.'
  }
  if (config.status !== 'active' && isHttps) {
    return 'NEXTAUTH_URL is https:// but TLS is NOT active. Sign-in will fail: update it to http://.'
  }
  return null
}
