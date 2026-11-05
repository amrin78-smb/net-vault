import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  certificateBlocks,
  daysUntil,
  describeCertificate,
  findOpenSsl,
  importCertificate,
  joinPem,
  looksLikePem,
  orderChain,
  pfxToPem,
  privateKeyBlock,
  validateCertificatePair,
} from '../lib/certImport.ts'

// ── fixtures ────────────────────────────────────────────────────────────────
//
// ⛔ NO KEY OR CERTIFICATE MATERIAL IS COMMITTED, AND NONE IS REAL. A genuine
// three-certificate chain (root → intermediate → leaf) is minted at test time
// into a temp dir, for the reserved-invalid name `console.invalid`, with a
// two-day life. ⛔ THE CHAIN HAS TO BE GENUINE: the whole point of this file is
// that an INTERMEDIATE survives three import paths, and a fake one would not
// exercise `orderChain`'s issuer walk or `checkPrivateKey` at all.

const PASS = 'fixture-only-not-a-secret'

type Chain = {
  dir: string
  leafPem: string
  intPem: string
  rootPem: string
  leafKeyPem: string
  otherKeyPem: string
  leafDer: Buffer
  pfx: Buffer
  noSanPem: string
  noSanKeyPem: string
}

let cached: Chain | undefined

/**
 * ⛔ IT THROWS RATHER THAN RETURNING null, AND THAT IS NOT A STYLE CHOICE. The
 * first version of this file wrapped the whole mint in a try/catch returning
 * null, and every test began `if (!c) return`. One unsupported OpenSSL flag
 * (`openssl req -not_after`, which 3.0.13 does not accept) then made the mint
 * fail, every test return early, and the suite report 27 PASSES while asserting
 * NOTHING — including both chain regressions this file exists to pin.
 * Mutation-verified: with that shape, deleting the `g` from
 * `certificateBlocks` killed no test at all. A fixture that cannot be built is
 * a FAILURE, loudly, naming the command.
 */
function mintChain(): Chain {
  if (cached !== undefined) return cached
  const openssl = findOpenSsl()
  if (!openssl) {
    throw new Error(
      'OpenSSL was not found, so the certificate chain these tests are about cannot be minted. '
      + 'This is a failure, not a skip: without it nothing here asserts anything.',
    )
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-certimport-'))
  const p = (n: string) => path.join(dir, n)
  const run = (args: string[]) =>
    execFileSync(openssl, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })

  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-noenc']
    // root (self-signed CA)
    run(['req', '-x509', ...ec, '-keyout', p('root.key'), '-out', p('root.crt'),
      '-days', '2', '-subj', '/CN=NV Fixture Root', '-addext', 'basicConstraints=critical,CA:TRUE'])
    // intermediate, signed by the root
    run(['req', '-new', ...ec, '-keyout', p('int.key'), '-out', p('int.csr'),
      '-subj', '/CN=NV Fixture Intermediate'])
    fs.writeFileSync(p('int.ext'), 'basicConstraints=critical,CA:TRUE\n')
    run(['x509', '-req', '-in', p('int.csr'), '-CA', p('root.crt'), '-CAkey', p('root.key'),
      '-out', p('int.crt'), '-days', '2', '-extfile', p('int.ext')])
    // leaf, signed by the intermediate — the certificate under test
    run(['req', '-new', ...ec, '-keyout', p('leaf.key'), '-out', p('leaf.csr'),
      '-subj', '/CN=console.invalid'])
    fs.writeFileSync(p('leaf.ext'), 'subjectAltName=DNS:console.invalid\nbasicConstraints=critical,CA:FALSE\n')
    run(['x509', '-req', '-in', p('leaf.csr'), '-CA', p('int.crt'), '-CAkey', p('int.key'),
      '-out', p('leaf.crt'), '-days', '2', '-extfile', p('leaf.ext')])
    run(['x509', '-in', p('leaf.crt'), '-outform', 'DER', '-out', p('leaf.cer')])
    // an unrelated key, for the mismatch test
    run(['req', '-x509', ...ec, '-keyout', p('other.key'), '-out', p('other.crt'),
      '-days', '2', '-subj', '/CN=other.invalid', '-addext', 'subjectAltName=DNS:other.invalid'])
    // ⛔ A SAN-LESS CERTIFICATE IS MINTED; AN EXPIRED ONE IS NOT. `openssl req`
    // has no `-not_after` in 3.0.13, so an expired fixture cannot be minted
    // portably — and `validateCertificatePair` takes `now` precisely so the
    // expiry branch is reachable without one. Asserting it with a future `now`
    // is the same branch with none of the fragility.
    run(['req', '-x509', ...ec, '-keyout', p('nosan.key'), '-out', p('nosan.crt'),
      '-days', '2', '-subj', '/CN=nosan.invalid'])

    fs.writeFileSync(p('chain.pem'), fs.readFileSync(p('int.crt'), 'utf8') + fs.readFileSync(p('root.crt'), 'utf8'))
    run(['pkcs12', '-export', '-inkey', p('leaf.key'), '-in', p('leaf.crt'),
      '-certfile', p('chain.pem'), '-out', p('leaf.pfx'), '-passout', `pass:${PASS}`])
    const pfx = fs.readFileSync(p('leaf.pfx'))

    cached = {
      dir,
      leafPem: fs.readFileSync(p('leaf.crt'), 'utf8'),
      intPem: fs.readFileSync(p('int.crt'), 'utf8'),
      rootPem: fs.readFileSync(p('root.crt'), 'utf8'),
      leafKeyPem: fs.readFileSync(p('leaf.key'), 'utf8'),
      otherKeyPem: fs.readFileSync(p('other.key'), 'utf8'),
      leafDer: fs.readFileSync(p('leaf.cer')),
      pfx,
      noSanPem: fs.readFileSync(p('nosan.crt'), 'utf8'),
      noSanKeyPem: fs.readFileSync(p('nosan.key'), 'utf8'),
    }
    return cached
}

/** The subject of the Nth certificate in a PEM bundle. */
function subjectAt(pem: string, i: number): string {
  const blocks = certificateBlocks(pem)
  return String(new crypto.X509Certificate(blocks[i]).subject)
}

// ── certificateBlocks: bug (b) ──────────────────────────────────────────────

test('certificateBlocks returns EVERY certificate in a bundle, not the first', () => {
  const c = mintChain()
  const bundle = c.leafPem + c.intPem + c.rootPem
  // ⛔ THIS IS BUG (b). SecVault's `text.match(/-----BEGIN CERTIFICATE-----
  // [\s\S]*?-----END CERTIFICATE-----/)` — one non-greedy match, `[0]` taken —
  // returns the leaf alone from exactly this input.
  assert.equal(certificateBlocks(bundle).length, 3)
})

test('certificateBlocks does not run two certificates together (non-greedy within a block)', () => {
  const c = mintChain()
  // A greedy body would make block 1 run from the first BEGIN to the LAST END,
  // producing one unparseable blob instead of three certificates.
  for (const block of certificateBlocks(c.leafPem + c.intPem + c.rootPem)) {
    assert.doesNotThrow(() => new crypto.X509Certificate(block))
  }
})

test('privateKeyBlock finds the key beside a certificate chain', () => {
  const c = mintChain()
  const combined = c.leafPem + c.intPem + c.leafKeyPem
  const key = privateKeyBlock(combined)
  assert.ok(key && /BEGIN (EC |RSA )?PRIVATE KEY/.test(key))
  assert.ok(!/BEGIN CERTIFICATE/.test(key as string))
})

// ── orderChain ──────────────────────────────────────────────────────────────

test('orderChain puts the leaf first and its issuer next, whatever order it is given', () => {
  const c = mintChain()
  const scrambled = [c.rootPem.trim(), c.intPem.trim(), c.leafPem.trim()]
  const ordered = orderChain(scrambled)
  assert.equal(ordered.length, 3)
  assert.match(subjectAt(joinPem(ordered), 0), /console\.invalid/)
  assert.match(subjectAt(joinPem(ordered), 1), /Intermediate/)
  assert.match(subjectAt(joinPem(ordered), 2), /Root/)
})

test('orderChain de-duplicates a repeated intermediate', () => {
  const c = mintChain()
  const ordered = orderChain([c.leafPem.trim(), c.intPem.trim(), c.intPem.trim()])
  assert.equal(ordered.length, 2)
})

test('orderChain keeps a certificate the issuer walk cannot reach', () => {
  const c = mintChain()
  // leaf + root with the intermediate missing: the walk stops after the leaf,
  // and the root must still be shipped rather than silently deleted.
  const ordered = orderChain([c.leafPem.trim(), c.rootPem.trim()])
  assert.equal(ordered.length, 2)
  assert.match(subjectAt(joinPem(ordered), 0), /console\.invalid/)
})

test('orderChain returns unparseable input unchanged rather than dropping it', () => {
  const blocks = ['-----BEGIN CERTIFICATE-----\nnotbase64\n-----END CERTIFICATE-----', 'x']
  assert.equal(orderChain(blocks).length, 2)
})

// ── the three import paths all keep the chain ───────────────────────────────

test('PATH 1 (pasted PEM): a fullchain + inline key keeps every certificate', () => {
  const c = mintChain()
  // ⛔ THE REGRESSION THIS PORT EXISTS FOR. This is the single commonest shape
  // an operator pastes (a `fullchain.pem` with the key appended), and it is the
  // input SecVault's non-greedy single match reduced to the leaf — so the one
  // upload most likely to CARRY a chain was the one guaranteed to lose it.
  const combined = c.leafPem + c.intPem + c.rootPem + c.leafKeyPem
  const r = importCertificate(Buffer.from(combined, 'utf8'))
  assert.equal(r.error, null)
  assert.equal(r.chainLength, 3)
  assert.equal(certificateBlocks(r.certPem as string).length, 3)
  assert.ok(r.keyPem && !/BEGIN CERTIFICATE/.test(r.keyPem))
  assert.match(subjectAt(r.certPem as string, 0), /console\.invalid/)
})

test('PATH 1 (pasted PEM): a separate key file wins and the chain still survives', () => {
  const c = mintChain()
  const r = importCertificate(
    Buffer.from(c.leafPem + c.intPem + c.rootPem, 'utf8'),
    Buffer.from(c.leafKeyPem, 'utf8'),
  )
  assert.equal(r.error, null)
  assert.equal(r.chainLength, 3)
})

test('PATH 2 (.cer/.der + key): the chain bundle supplies the intermediate', () => {
  const c = mintChain()
  // ⛔ A DER FILE HOLDS EXACTLY ONE CERTIFICATE, which is why this path takes a
  // chain bundle at all: without it there is no way to get an intermediate onto
  // the server on the path a Windows certificate-store export actually
  // produces, and the result is a leaf-only chain.
  assert.ok(!looksLikePem(c.leafDer))
  const r = importCertificate(
    c.leafDer,
    Buffer.from(c.leafKeyPem, 'utf8'),
    null,
    Buffer.from(c.intPem + c.rootPem, 'utf8'),
  )
  assert.equal(r.error, null)
  assert.equal(r.chainLength, 3)
  assert.match(subjectAt(r.certPem as string, 0), /console\.invalid/)
  assert.match(subjectAt(r.certPem as string, 1), /Intermediate/)
})

test('PATH 2 (.cer/.der): no key is reported as advice, and the leaf still converts', () => {
  const c = mintChain()
  const r = importCertificate(c.leafDer)
  assert.match(String(r.error), /certificate only/i)
  assert.equal(r.chainLength, 1)
  assert.ok(r.certPem && /BEGIN CERTIFICATE/.test(r.certPem))
})

test('PATH 3 (.pfx): the full chain comes out of the PKCS#12 container', () => {
  const c = mintChain()
  // ⛔ THIS IS BUG (a). `openssl pkcs12 -nokeys -clcerts` emits ONE
  // certificate from this exact container (verified: 1 vs 3); without
  // `-clcerts` it emits the client certificate AND the CA certificates, which
  // is what a .pfx from a Microsoft CA contains and what has to be served.
  const r = pfxToPem(c.pfx, PASS)
  assert.equal(r.error, null)
  assert.equal(r.chainLength, 3)
  assert.equal(certificateBlocks(r.certPem as string).length, 3)
  // And leaf-first, because the bag order in a container is arbitrary.
  assert.match(subjectAt(r.certPem as string, 0), /console\.invalid/)
  assert.ok(r.keyPem && /BEGIN (EC |RSA )?PRIVATE KEY/.test(r.keyPem))
  assert.ok(!/BEGIN CERTIFICATE/.test(r.keyPem as string))
})

test('PATH 3 (.pfx): importCertificate routes a container to the PKCS#12 path', () => {
  const c = mintChain()
  const r = importCertificate(c.pfx, null, PASS)
  assert.equal(r.error, null)
  assert.equal(r.chainLength, 3)
})

test('PATH 3 (.pfx): a wrong password is named as a wrong password', () => {
  const c = mintChain()
  const r = pfxToPem(c.pfx, 'definitely-not-the-password')
  assert.equal(r.certPem, null)
  assert.match(String(r.error), /password did not open/i)
})

test('an installed pair that came through any path validates as a chain', () => {
  const c = mintChain()
  const r = importCertificate(Buffer.from(c.leafPem + c.intPem + c.rootPem + c.leafKeyPem, 'utf8'))
  const info = validateCertificatePair(r.certPem, r.keyPem)
  assert.equal(info.valid, true)
  assert.equal(info.chainLength, 3)
  assert.equal(info.chain?.length, 3)
})

// ── validation ──────────────────────────────────────────────────────────────

test('a mismatched certificate and key is refused by checkPrivateKey', () => {
  const c = mintChain()
  // ⛔ THE GUARD THE WHOLE FEATURE RESTS ON. Both halves parse perfectly; this
  // pair fails only at the next restart, weeks later, during an unrelated
  // upgrade, and takes the console down.
  const info = validateCertificatePair(c.leafPem, c.otherKeyPem)
  assert.equal(info.valid, false)
  assert.match(String(info.error), /does not belong to this certificate/i)
})

test('a matching pair is accepted and described', () => {
  const c = mintChain()
  const info = validateCertificatePair(c.leafPem, c.leafKeyPem)
  assert.equal(info.valid, true)
  assert.equal(info.error, null)
  assert.deepEqual(info.sans, ['DNS:console.invalid'])
  assert.equal(info.expired, false)
})

test('an unparseable intermediate in a bundle is refused, not ignored', () => {
  const c = mintChain()
  const broken = c.leafPem + '-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n'
  const info = validateCertificatePair(broken, c.leafKeyPem)
  assert.equal(info.valid, false)
  assert.match(String(info.error), /Certificate 2 of 2/)
})

test('an expired certificate is refused', () => {
  const c = mintChain()
  // The fixture lives two days; judged from a month hence it is expired.
  const future = new Date(Date.now() + 30 * 86400000)
  const info = validateCertificatePair(c.leafPem, c.leafKeyPem, future)
  assert.equal(info.valid, false)
  assert.match(String(info.error), /expired/i)
  // ⛔ Spread-then-override: the describing fields survive the refusal.
  assert.ok(info.subject)
})

test('a certificate with no SANs is refused', () => {
  const c = mintChain()
  const info = validateCertificatePair(c.noSanPem, c.noSanKeyPem)
  assert.equal(info.valid, false)
  assert.match(String(info.error), /Subject Alternative Names/i)
})

test('a certificate in the private key box is named as that, not as a parse error', () => {
  const c = mintChain()
  // ⛔ ASSERTED SEPARATELY FROM THE "that is not a certificate" MESSAGE. An
  // earlier version of this test accepted either string, so deleting the
  // swapped-boxes guard entirely still passed — the generic refusal fired
  // instead and the operator would be told to check the wrong box.
  const info = validateCertificatePair(c.leafPem, c.intPem)
  assert.equal(info.valid, false)
  assert.match(String(info.error), /private key box contains a certificate/i)
})

test('a private key in the certificate box is named as that', () => {
  const c = mintChain()
  const info = validateCertificatePair(c.leafKeyPem, c.leafPem)
  assert.equal(info.valid, false)
  assert.match(String(info.error), /does not look like a certificate/i)
})

test('a passphrase-protected key is refused with the reason', () => {
  const key = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----'
  const c = mintChain()
  const info = validateCertificatePair(c.leafPem, key)
  assert.equal(info.valid, false)
  assert.match(String(info.error), /passphrase/i)
})

test('an empty certificate or key is refused before anything is parsed', () => {
  assert.match(String(validateCertificatePair('', 'x').error), /Paste the certificate/)
  assert.match(String(validateCertificatePair('-----BEGIN CERTIFICATE-----', '').error), /Paste the private key/)
})

// ── description ─────────────────────────────────────────────────────────────

test('describeCertificate reports the LEAF and counts the chain', () => {
  const c = mintChain()
  const d = describeCertificate(c.leafPem + c.intPem + c.rootPem) as {
    subject: string
    chainLength: number
    chain: unknown[]
  }
  assert.match(d.subject, /console\.invalid/)
  assert.equal(d.chainLength, 3)
  assert.equal(d.chain.length, 3)
})

test('describeCertificate needs no key and reports a parse error as one', () => {
  assert.equal(describeCertificate(''), null)
  assert.ok('parseError' in (describeCertificate('-----BEGIN CERTIFICATE-----\nz\n-----END CERTIFICATE-----') as object))
})

test('daysUntil is negative for a past date', () => {
  const ref = new Date('2026-01-10T00:00:00Z')
  assert.equal(daysUntil(new Date('2026-01-20T00:00:00Z'), ref), 10)
  assert.ok(daysUntil(new Date('2026-01-01T00:00:00Z'), ref) < 0)
})

test('importCertificate refuses an empty upload and text with no certificate', () => {
  assert.match(String(importCertificate(null).error), /No certificate file/)
  assert.match(
    String(importCertificate(Buffer.from('-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----', 'utf8')).error),
    /No certificate was found/,
  )
})
