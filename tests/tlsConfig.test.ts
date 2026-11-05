import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  DEFAULT_HTTPS_PORT,
  DEFAULT_HTTP_REDIRECT_PORT,
  describeTlsStatus,
  expectedOrigin,
  nextAuthUrlMismatch,
  portFrom,
  resolveTlsConfig,
  type TlsConfig,
  type TlsEnv,
  type TlsFsImpl,
} from '../lib/tlsConfig.ts'

// ── fixtures ────────────────────────────────────────────────────────────────
//
// ⛔ NO KEY OR CERTIFICATE FILE IS COMMITTED. Anything that needs real material
// is minted into a temp dir at test time, for a reserved-invalid name, with a
// two-day life. Everything else runs off an injected `fsImpl`.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nv-tlsconfig-'))
}

/** Two files on the real filesystem, with whatever bytes a test wants. */
function materialOnDisk(cert: string, key: string): { certPath: string; keyPath: string } {
  const dir = tmpDir()
  const certPath = path.join(dir, 'console.crt')
  const keyPath = path.join(dir, 'console.key')
  fs.writeFileSync(certPath, cert)
  fs.writeFileSync(keyPath, key)
  return { certPath, keyPath }
}

/**
 * A genuine self-signed pair, via the OpenSSL that Git for Windows ships and
 * every Linux box already has. Returns null when openssl is unavailable, so a
 * box without it degrades to the injected-builder assertions rather than
 * failing a test for a reason that has nothing to do with this module.
 */
function realPair(label: string): { certPath: string; keyPath: string } | null {
  const dir = tmpDir()
  const certPath = path.join(dir, `${label}.crt`)
  const keyPath = path.join(dir, `${label}.key`)
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '2',
        // RFC 2606 reserved name — never resolves, never a real host.
        '-subj', '/CN=tls-test.invalid',
        '-addext', 'subjectAltName=DNS:tls-test.invalid',
      ],
      { stdio: 'ignore' },
    )
    return { certPath, keyPath }
  } catch {
    return null
  }
}

/**
 * An `fsImpl` whose secure-context builder ALWAYS SUCCEEDS.
 *
 * ⛔ Load-bearing for the empty-file test. With the real builder, zero bytes
 * also fail the context build, so deleting the empty-file guard would still
 * produce `failed` and the test would pass with its guard gone — pinning the
 * mechanism instead of the outcome. A permissive builder leaves the empty-file
 * guard as the ONLY thing that can catch it.
 */
const acceptsAnything: TlsFsImpl = { createSecureContext: () => ({}) }

/** An `fsImpl` whose builder throws like OpenSSL does, without key material. */
function rejectsWith(code: string, message: string): TlsFsImpl {
  return {
    createSecureContext: () => {
      const err = new Error(message) as NodeJS.ErrnoException
      err.code = code
      throw err
    },
  }
}

/**
 * A `failed` config built by hand.
 *
 * ⛔ Deliberately NOT produced by driving `resolveTlsConfig` into a failure.
 * `describeTlsStatus`, `expectedOrigin` and `nextAuthUrlMismatch` are pure
 * functions OF a config; building one here keeps their tests independent of
 * which resolver guard produced it, so a broken guard fails the one test that
 * owns it rather than smearing across the file.
 */
function failedConfig(error = 'Certificate file is empty: /tmp/nope.crt'): TlsConfig {
  return {
    status: 'failed',
    httpsPort: 3000,
    httpPort: 3080,
    cert: null,
    key: null,
    certPath: '/tmp/nope.crt',
    keyPath: '/tmp/nope.key',
    error,
  }
}

const NO_ENV: TlsEnv = {}

// ── state 1 of 3: disabled ──────────────────────────────────────────────────

test('no cert paths at all is disabled — the way the suite has always shipped, not an error', () => {
  for (const env of [NO_ENV, { TLS_CERT_PATH: '', TLS_KEY_PATH: '   ' }] as TlsEnv[]) {
    const c = resolveTlsConfig(env, acceptsAnything)
    assert.equal(c.status, 'disabled')
    // ⛔ `error` is the marker a caller logs on. `disabled` carries none.
    assert.equal(c.error, null)
    assert.equal(c.certPath, null)
    assert.equal(c.keyPath, null)
    assert.equal(c.cert, null)
    assert.equal(c.key, null)
  }
})

// ── state 2 of 3: active ────────────────────────────────────────────────────

test('two readable, non-empty, loadable files is active and carries the material', () => {
  const { certPath, keyPath } = materialOnDisk('-----BEGIN CERTIFICATE-----\nx\n', 'k')
  const c = resolveTlsConfig({ TLS_CERT_PATH: certPath, TLS_KEY_PATH: keyPath }, acceptsAnything)
  assert.equal(c.status, 'active')
  assert.equal(c.error, null)
  assert.ok(c.cert && c.cert.length > 0, 'the certificate bytes are returned, not just a verdict')
  assert.ok(c.key && c.key.length > 0, 'the key bytes are returned, not just a verdict')
  assert.equal(c.certPath, certPath)
  assert.equal(c.keyPath, keyPath)
})

test('active through the REAL node:fs and node:tls defaults, with real OpenSSL material', () => {
  const pair = realPair('good')
  if (!pair) return // openssl absent — covered by the injected-builder test above
  // ⛔ No fsImpl at all. Defaulting to the real stack is the entire point of
  // the load check, so one test has to actually take that default.
  const c = resolveTlsConfig({ TLS_CERT_PATH: pair.certPath, TLS_KEY_PATH: pair.keyPath })
  assert.equal(c.status, 'active', c.error || '')
  assert.equal(c.error, null)
})

// ── state 3 of 3: failed — every route into it ──────────────────────────────

test('half-configured in either direction is failed, never disabled', () => {
  const certOnly = resolveTlsConfig({ TLS_CERT_PATH: '/tmp/only.crt' }, acceptsAnything)
  assert.equal(certOnly.status, 'failed')
  assert.match(String(certOnly.error), /half-configured/)
  assert.match(String(certOnly.error), /TLS_KEY_PATH/)
  assert.match(describeTlsStatus(certOnly), /CONFIGURED BUT NOT ACTIVE/)

  const keyOnly = resolveTlsConfig({ TLS_KEY_PATH: '/tmp/only.key' }, acceptsAnything)
  assert.equal(keyOnly.status, 'failed')
  assert.match(String(keyOnly.error), /half-configured/)
  assert.match(String(keyOnly.error), /TLS_CERT_PATH/)
  assert.match(describeTlsStatus(keyOnly), /CONFIGURED BUT NOT ACTIVE/)

  // Whitespace is not a configuration. ' ' + a real path is still half-done.
  const blankKey = resolveTlsConfig(
    { TLS_CERT_PATH: '/tmp/only.crt', TLS_KEY_PATH: '   ' },
    acceptsAnything,
  )
  assert.equal(blankKey.status, 'failed')
})

test('an unreadable file is failed and the read error survives', () => {
  const dir = tmpDir()
  const missing = path.join(dir, 'does-not-exist.crt')
  const { keyPath } = materialOnDisk('c', 'k')
  const c = resolveTlsConfig({ TLS_CERT_PATH: missing, TLS_KEY_PATH: keyPath }, acceptsAnything)
  assert.equal(c.status, 'failed')
  assert.match(String(c.error), /Could not read the TLS certificate or key/)
  assert.match(String(c.error), /ENOENT/, 'the underlying errno is kept, not flattened')
  assert.match(describeTlsStatus(c), /CONFIGURED BUT NOT ACTIVE/)

  // An injected reader that throws something that is not an Error at all must
  // not turn a `failed` into a crash.
  const hostile: TlsFsImpl = {
    readFileSync: () => {
      throw 'denied'
    },
    createSecureContext: () => ({}),
  }
  const c2 = resolveTlsConfig({ TLS_CERT_PATH: '/a', TLS_KEY_PATH: '/b' }, hostile)
  assert.equal(c2.status, 'failed')
  assert.match(String(c2.error), /denied/)
})

test('an empty certificate or key file is failed, not active', () => {
  // ⛔ `acceptsAnything` means the empty-file guard is the ONLY thing that can
  // catch these. Without it both would come back `active` with zero bytes of
  // certificate — see the comment on the fixture.
  const emptyCert = materialOnDisk('', 'a key')
  const c1 = resolveTlsConfig(
    { TLS_CERT_PATH: emptyCert.certPath, TLS_KEY_PATH: emptyCert.keyPath },
    acceptsAnything,
  )
  assert.equal(c1.status, 'failed')
  assert.match(String(c1.error), /Certificate file is empty/)
  assert.match(String(c1.error), /console\.crt/, 'the error names the file')
  assert.match(describeTlsStatus(c1), /CONFIGURED BUT NOT ACTIVE/)

  const emptyKey = materialOnDisk('a cert', '')
  const c2 = resolveTlsConfig(
    { TLS_CERT_PATH: emptyKey.certPath, TLS_KEY_PATH: emptyKey.keyPath },
    acceptsAnything,
  )
  assert.equal(c2.status, 'failed')
  assert.match(String(c2.error), /Private key file is empty/)
  assert.match(String(c2.error), /console\.key/)
  assert.match(describeTlsStatus(c2), /CONFIGURED BUT NOT ACTIVE/)
})

test('material the secure-context builder rejects is failed, with the OpenSSL code kept', () => {
  // (a) Injected throw — deterministic, and the only part of this test that
  //     needs neither openssl nor real key material.
  const injected = resolveTlsConfig(
    { TLS_CERT_PATH: '/a', TLS_KEY_PATH: '/b' },
    {
      readFileSync: () => Buffer.from('some bytes'),
      ...rejectsWith('ERR_OSSL_PEM_NO_START_LINE', 'error:0480006C:PEM routines::no start line'),
    },
  )
  assert.equal(injected.status, 'failed')
  assert.match(String(injected.error), /could not be loaded/)
  assert.match(
    String(injected.error),
    /ERR_OSSL_PEM_NO_START_LINE/,
    'the code is the useful half — not flattened to "certificate invalid"',
  )
  assert.match(describeTlsStatus(injected), /CONFIGURED BUT NOT ACTIVE/)

  // A builder that throws a bare string still produces `failed`, not a crash,
  // and still says something.
  const noCode = resolveTlsConfig(
    { TLS_CERT_PATH: '/a', TLS_KEY_PATH: '/b' },
    {
      readFileSync: () => Buffer.from('some bytes'),
      createSecureContext: () => {
        throw 'nope'
      },
    },
  )
  assert.equal(noCode.status, 'failed')
  assert.match(String(noCode.error), /unknown error/)

  // (b) REAL node:tls, non-empty files that are not PEM at all — the DER `.cer`
  //     saved over the `.crt` / truncated-download class. No openssl needed.
  const garbage = materialOnDisk('this is not a certificate', 'this is not a key')
  const notPem = resolveTlsConfig({
    TLS_CERT_PATH: garbage.certPath,
    TLS_KEY_PATH: garbage.keyPath,
  })
  assert.equal(notPem.status, 'failed')
  assert.match(String(notPem.error), /ERR_OSSL_PEM_NO_START_LINE/)

  // (c) REAL node:tls, two valid halves that belong to different pairs — the
  //     restored-`.bak` class, which parses perfectly and only ever fails here.
  const a = realPair('pair-a')
  const b = realPair('pair-b')
  if (a && b) {
    const mismatched = resolveTlsConfig({ TLS_CERT_PATH: a.certPath, TLS_KEY_PATH: b.keyPath })
    assert.equal(mismatched.status, 'failed')
    assert.match(
      String(mismatched.error),
      /ERR_OSSL_X509_KEY_VALUES_MISMATCH/,
      'a mismatch and an unparseable file are different problems with different fixes',
    )
  }
})

// ── the whole reason this module exists ─────────────────────────────────────

test('describeTlsStatus for failed can never be mistaken for disabled', () => {
  const disabled = describeTlsStatus(resolveTlsConfig(NO_ENV, acceptsAnything))
  const active = describeTlsStatus(
    resolveTlsConfig({ TLS_CERT_PATH: '/a', TLS_KEY_PATH: '/b' }, {
      readFileSync: () => Buffer.from('bytes'),
      createSecureContext: () => ({}),
    }),
  )
  const failed = describeTlsStatus(failedConfig('The certificate and key could not be loaded'))

  // The actual strings, not the status field.
  assert.notEqual(failed, disabled)
  assert.notEqual(failed, active)
  assert.notEqual(active, disabled)

  // ⛔ `failed` must read as a problem to someone skimming a startup log.
  assert.match(failed, /CONFIGURED BUT NOT ACTIVE/)
  assert.ok(failed.includes('could not be loaded'), 'it carries the reason, not just a verdict')
  assert.ok(
    !/not configured/.test(failed),
    'the phrase that means "disabled" must never appear in the failed line',
  )

  // ⛔ …and the converse: `disabled` must not borrow any alarming wording from
  // `failed`, or a normal plaintext install reads as broken and the alarm
  // stops meaning anything.
  assert.match(disabled, /not configured/)
  assert.ok(!/NOT ACTIVE/.test(disabled))
  assert.ok(!disabled.includes('CONFIGURED BUT'))

  // Neither line can be a substring of the other in either direction.
  assert.ok(!failed.includes(disabled) && !disabled.includes(failed))

  // `active` is the only line that claims encryption.
  assert.match(active, /ACTIVE on port/)
  assert.ok(!active.includes('plain HTTP'))
  assert.ok(failed.includes('plain HTTP'), 'failed states what IS being served')
  assert.ok(disabled.includes('plain HTTP'))

  // A missing config is its own answer, never a quiet "disabled".
  assert.equal(describeTlsStatus(null), 'TLS: unknown')
  assert.equal(describeTlsStatus(undefined), 'TLS: unknown')
})

// ── ports ───────────────────────────────────────────────────────────────────

test('port parsing never yields NaN, zero or an out-of-range port', () => {
  // portFrom in isolation.
  for (const bad of ['', '   ', 'abc', '0', '-1', '65536', '99999', 'NaN', null, undefined, {}, []]) {
    const got = portFrom(bad, 4321)
    assert.equal(got, 4321, `${JSON.stringify(bad)} must fall back`)
    assert.ok(Number.isInteger(got) && got > 0 && got < 65536)
  }
  assert.equal(portFrom('8443', 1), 8443)
  assert.equal(portFrom(' 8443 ', 1), 8443)
  assert.equal(portFrom(8443, 1), 8443)
  assert.equal(portFrom('65535', 1), 65535)
  assert.equal(portFrom('1', 9), 1)
  // '3000abc' parses to 3000 under parseInt — accepted deliberately, because a
  // stray character must not silently move the listener to a different port.
  assert.equal(portFrom('3000abc', 1), 3000)

  // …and through resolveTlsConfig, where a NaN would reach listen().
  const absent = resolveTlsConfig(NO_ENV, acceptsAnything)
  assert.equal(absent.httpsPort, DEFAULT_HTTPS_PORT)
  assert.equal(absent.httpPort, DEFAULT_HTTP_REDIRECT_PORT)
  assert.equal(DEFAULT_HTTPS_PORT, 3000, 'the built-in default is the hub')

  for (const bad of ['', 'abc', '0', '-7', '70000']) {
    const c = resolveTlsConfig({ HTTPS_PORT: bad, HTTP_REDIRECT_PORT: bad }, acceptsAnything)
    assert.ok(!Number.isNaN(c.httpsPort), `HTTPS_PORT=${bad} produced NaN`)
    assert.ok(!Number.isNaN(c.httpPort), `HTTP_REDIRECT_PORT=${bad} produced NaN`)
    assert.equal(c.httpsPort, DEFAULT_HTTPS_PORT)
    assert.equal(c.httpPort, DEFAULT_HTTP_REDIRECT_PORT)
  }

  const set = resolveTlsConfig({ HTTPS_PORT: '3008', HTTP_REDIRECT_PORT: '8080' }, acceptsAnything)
  assert.equal(set.httpsPort, 3008)
  assert.equal(set.httpPort, 8080)

  // PORT is the fallback NSSM already pins; HTTPS_PORT wins over it.
  assert.equal(resolveTlsConfig({ PORT: '3004' }, acceptsAnything).httpsPort, 3004)
  assert.equal(
    resolveTlsConfig({ PORT: '3004', HTTPS_PORT: '3006' }, acceptsAnything).httpsPort,
    3006,
  )

  // ⛔ Per-app defaults, because ONE terminator stands in front of four
  // consoles. Nothing here may be nailed to the hub's port.
  const perApp = resolveTlsConfig(NO_ENV, acceptsAnything, { httpsPort: 3006, httpPort: 8081 })
  assert.equal(perApp.httpsPort, 3006)
  assert.equal(perApp.httpPort, 8081)
  // A junk default is still not NaN.
  const junkDefault = resolveTlsConfig(NO_ENV, acceptsAnything, {
    httpsPort: Number.NaN,
    httpPort: 0,
  })
  assert.equal(junkDefault.httpsPort, DEFAULT_HTTPS_PORT)
  assert.equal(junkDefault.httpPort, DEFAULT_HTTP_REDIRECT_PORT)
  // The environment still beats a per-app default.
  assert.equal(
    resolveTlsConfig({ HTTPS_PORT: '3002' }, acceptsAnything, { httpsPort: 3006 }).httpsPort,
    3002,
  )
})

// ── the silent sign-in breaker ──────────────────────────────────────────────

test('nextAuthUrlMismatch catches a scheme that disagrees with the transport', () => {
  const active = resolveTlsConfig({ TLS_CERT_PATH: '/a', TLS_KEY_PATH: '/b' }, {
    readFileSync: () => Buffer.from('bytes'),
    createSecureContext: () => ({}),
  })
  const disabled = resolveTlsConfig(NO_ENV, acceptsAnything)
  const failed = failedConfig()

  assert.equal(nextAuthUrlMismatch(active, 'https://console.invalid:3000'), null)
  assert.equal(nextAuthUrlMismatch(disabled, 'http://console.invalid:3000'), null)

  assert.match(
    String(nextAuthUrlMismatch(active, 'http://console.invalid:3000')),
    /TLS is active/,
  )
  assert.match(
    String(nextAuthUrlMismatch(disabled, 'https://console.invalid:3000')),
    /TLS is NOT active/,
  )

  // ⛔ The case an operator actually lands in: a bad certificate was uploaded,
  // NEXTAUTH_URL was flipped to https, and the server is serving plaintext.
  // `failed` is NOT active, so this must report, or sign-in breaks with no
  // error anywhere while the transport banner is the only clue.
  assert.match(
    String(nextAuthUrlMismatch(failed, 'https://console.invalid:3000')),
    /TLS is NOT active/,
  )
  assert.equal(nextAuthUrlMismatch(failed, 'http://console.invalid:3000'), null)

  // Case and surrounding whitespace must not hide a mismatch.
  assert.match(String(nextAuthUrlMismatch(disabled, '  HTTPS://console.invalid  ')), /NOT active/)

  // Nothing to compare against is not a mismatch.
  assert.equal(nextAuthUrlMismatch(active, undefined), null)
  assert.equal(nextAuthUrlMismatch(active, ''), null)
  assert.equal(nextAuthUrlMismatch(null, 'https://console.invalid'), null)
})

test('expectedOrigin follows the transport actually being served', () => {
  const active = resolveTlsConfig(
    { TLS_CERT_PATH: '/a', TLS_KEY_PATH: '/b', HTTPS_PORT: '3008' },
    { readFileSync: () => Buffer.from('bytes'), createSecureContext: () => ({}) },
  )
  assert.equal(expectedOrigin(active, 'console.invalid'), 'https://console.invalid:3008')

  const disabled = resolveTlsConfig(NO_ENV, acceptsAnything)
  assert.equal(expectedOrigin(disabled, 'console.invalid'), 'http://console.invalid:3000')

  // ⛔ `failed` is http://, like `disabled` — because that is what is being
  // served. The honesty lives in describeTlsStatus, not in the origin.
  assert.equal(expectedOrigin(failedConfig(), 'console.invalid'), 'http://console.invalid:3000')

  assert.equal(expectedOrigin(disabled), 'http://localhost:3000')
  assert.equal(expectedOrigin(null), `http://localhost:${DEFAULT_HTTPS_PORT}`)
})
