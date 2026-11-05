//
// lib/certImport.ts — turning whatever a Windows administrator actually has
// into the PEM pair node needs, and refusing a pair that cannot work BEFORE it
// reaches disk.
//
// ⛔ WHY IT ACCEPTS THREE FORMATS. A Microsoft CA hands out `.pfx`; "export the
// certificate" in the Windows certificate store offers `.cer`; almost nothing
// on Windows produces the PEM pair node wants. Requiring an operator to run
// three OpenSSL commands before they can install a certificate is how this
// feature goes unused and the console stays on plain HTTP forever. Accepting
// what they have is the difference between a shipped feature and a documented
// one.
//
//   PEM          normalised. Already what we want; every CERTIFICATE block is
//                kept and a key may be inline in the same file.
//   DER (.cer)   converted IN PROCESS — node's X509Certificate reads DER and
//                re-emits PEM, so no external tool is needed. An optional
//                separate chain bundle carries the intermediates, which a
//                single DER file cannot.
//   PKCS#12      converted with OpenSSL. There is no PKCS#12 reader in node's
//   (.pfx/.p12)  crypto and adding an ASN.1 dependency to authentication code
//                to read a container format would be a poor trade. OpenSSL
//                ships with Git for Windows, already a hard dependency of the
//                suite installer.
//
// ⛔ THE INTERMEDIATE CERTIFICATE IS PART OF THE CERTIFICATE. Ported from
// secvault/lib/certImport.js, which drops it on TWO of the three paths, and
// this deployment uses a real CA-issued wildcard whose chain needs it. Both
// bugs are fixed here and both are pinned by tests/certImport.test.ts:
//
//   (a) `openssl pkcs12 -nokeys -clcerts` emits the CLIENT certificate ONLY.
//       `-clcerts` is gone; the full chain is emitted and ordered.
//   (b) `text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END .../)` is a
//       NON-GREEDY single match, so it keeps the FIRST block and silently
//       discards every intermediate after it. Replaced by `certificateBlocks`,
//       which collects ALL of them, on every path.
//
// ⛔ A LEAF-ONLY CHAIN IS THE WORST KIND OF BROKEN: it validates in any browser
// that happens to have the intermediate cached from another site and fails in
// strict clients (openssl s_client, java, go, curl, every API consumer), so the
// failure is intermittent, per-client, and reliably misattributed to the
// client. There is no error anywhere on our side. That is why it is worth
// fixing in a port rather than carrying over.
//
// ⛔ A PFX HOLDS THE PRIVATE KEY. Everything here runs on material that must
// not be logged, echoed, or left on disk: the temp file has a random name, is
// read once, and is removed in a `finally`. The passphrase goes to OpenSSL
// through the ENVIRONMENT, never argv, because a command line is readable by
// any other process on the box — and the child gets a MINIMAL environment, not
// a copy of ours, so it never sees DATABASE_URL or NEXTAUTH_SECRET.
//
// Pure apart from `node:crypto` for the validation/description half, which is
// what lets tests/certImport.test.ts drive every branch off material it mints
// itself. No committed key material anywhere.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const PEM_CERT = /-----BEGIN CERTIFICATE-----/
export const PEM_KEY = /-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/

/**
 * EVERY certificate block in a PEM text, in the order they appear.
 *
 * ⛔ THIS FUNCTION IS BUG (b)'s FIX AND THE REASON THE PORT EXISTS. The
 * original wrote `text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END
 * CERTIFICATE-----/)` — one match, non-greedy — and used `[0]`. On a bundle
 * holding `leaf, intermediate, root` that returns the leaf alone, and nothing
 * downstream can tell: the result parses, validates, matches its key, and
 * serves. The chain is simply absent.
 *
 * The regex here is GLOBAL (all blocks) and non-greedy WITHIN a block (so block
 * N ends at its own END line rather than at the last one in the file). Both
 * halves are load-bearing: make it greedy and three certificates collapse into
 * one unparseable blob; drop the `g` and the original bug is back.
 */
export function certificateBlocks(text: string | null | undefined): string[] {
  const src = String(text == null ? '' : text)
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  return src.match(re) || []
}

/** The private key block, or null. One key; a PEM pair never carries two. */
export function privateKeyBlock(text: string | null | undefined): string | null {
  const m = String(text == null ? '' : text).match(
    /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/,
  )
  return m ? m[0] : null
}

/** One newline-separated PEM document, normalised, with a trailing newline. */
export function joinPem(blocks: string[]): string {
  return blocks.map((b) => b.trim()).filter(Boolean).join('\n') + '\n'
}

/**
 * Order a set of certificate blocks LEAF FIRST, then each issuer in turn.
 *
 * ⛔ ORDER IS NOT COSMETIC. TLS requires the end-entity certificate first and
 * each following certificate to certify the one before it; a bundle that starts
 * with the root is rejected outright by some clients and accepted by others,
 * which is the same intermittent failure mode as a missing intermediate. The
 * PKCS#12 bag order and the order an operator pastes blocks in are both
 * arbitrary, so neither may be trusted.
 *
 * ⛔ UNPARSEABLE INPUT IS RETURNED UNCHANGED, NEVER DROPPED. This function's
 * job is ordering, not validation — `validateCertificatePair` refuses what
 * cannot be parsed, with a message about parsing. Silently removing a block
 * here would turn a bad paste into a quietly shortened chain, which is the
 * exact class of bug this file exists to end.
 */
export function orderChain(blocks: string[]): string[] {
  // Deduplicate first: a paste of leaf+chain alongside a chain bundle commonly
  // repeats the intermediate, and a duplicate in a served chain is wasted bytes
  // at best and a confused client at worst.
  const seen = new Set<string>()
  const unique: string[] = []
  for (const b of blocks) {
    const k = b.replace(/\s+/g, '')
    if (!k || seen.has(k)) continue
    seen.add(k)
    unique.push(b.trim())
  }
  if (unique.length < 2) return unique

  type Node = { pem: string; subject: string; issuer: string }
  let parsed: Node[]
  try {
    parsed = unique.map((pem) => {
      const x = new crypto.X509Certificate(pem)
      return { pem, subject: String(x.subject), issuer: String(x.issuer) }
    })
  } catch {
    return unique
  }

  // The leaf issues nothing else in the set. `i !== idx` excludes a
  // self-signed certificate's reference to itself, which would otherwise make
  // every root look like an issuer of something and leave no leaf at all.
  const issuesSomething = (idx: number) =>
    parsed.some((p, i) => i !== idx && p.issuer === parsed[idx].subject)
  const leafIdx = parsed.findIndex((_, i) => !issuesSomething(i))
  if (leafIdx < 0) return unique

  const ordered: Node[] = []
  const used = new Set<number>()
  let cursor: number | undefined = leafIdx
  while (cursor !== undefined && !used.has(cursor)) {
    used.add(cursor)
    ordered.push(parsed[cursor])
    const issuerName = parsed[cursor].issuer
    const next = parsed.findIndex((p, i) => !used.has(i) && p.subject === issuerName)
    cursor = next < 0 ? undefined : next
  }
  // ⛔ ANYTHING THE WALK DID NOT REACH IS APPENDED, NOT DISCARDED. A bundle
  // with a gap in it (the operator pasted leaf + root and forgot the
  // intermediate) still ships every certificate they gave us; dropping the
  // orphan would make this function quietly delete certificate material to
  // tidy up its own output.
  for (let i = 0; i < parsed.length; i += 1) if (!used.has(i)) ordered.push(parsed[i])
  return ordered.map((n) => n.pem)
}

/**
 * Where OpenSSL lives on a NocVault host.
 *
 * ⛔ Git for Windows is a hard dependency of `Install-NocVault-Suite.ps1`, so
 * it is present by the time anything here runs. The POSIX paths are for the
 * dev box and CI, where the pfx path has to be exercisable at all.
 */
export function findOpenSsl(): string | null {
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\PostgreSQL\\16\\bin\\openssl.exe',
    '/usr/bin/openssl',
    '/usr/local/bin/openssl',
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* keep looking */
    }
  }
  return null
}

/** Is this buffer text that looks like PEM? */
export function looksLikePem(buf: Buffer): boolean {
  // Only sniff the head: a PFX is binary and may contain anything later on.
  const head = buf.subarray(0, 2048).toString('latin1')
  return PEM_CERT.test(head) || PEM_KEY.test(head)
}

/**
 * Convert a DER certificate to PEM, in process.
 *
 * ⛔ No external tool. node's X509Certificate accepts DER and `toString()`
 * emits PEM, so a `.cer` exported from the Windows certificate store needs
 * nothing but this. A DER file holds exactly ONE certificate, which is why the
 * DER path takes a separate chain bundle.
 */
export function derCertToPem(buf: Buffer): string {
  return new crypto.X509Certificate(buf).toString()
}

export type ImportResult = {
  certPem: string | null
  keyPem: string | null
  error: string | null
  /** How many certificates the normalised `certPem` carries. 1 means leaf-only. */
  chainLength: number
}

const OPENSSL_MISSING =
  'A .pfx file needs OpenSSL to unpack, and it was not found on this server. Export the '
  + 'certificate and key to PEM on another machine, or paste them directly.'

/**
 * Extract cert chain + key PEM from a PKCS#12 container.
 *
 * ⛔ `-clcerts` IS DELIBERATELY ABSENT AND MUST STAY ABSENT — THIS IS BUG (a).
 * `openssl pkcs12 -nokeys -clcerts` emits the client certificate and nothing
 * else, so every intermediate in the container is thrown away by the one
 * command whose whole job is to get the certificate out of it. Without the flag
 * OpenSSL emits the client certificate AND the CA certificates, which is what a
 * `.pfx` from a Microsoft CA actually contains and what the server has to
 * serve. `certificateBlocks` + `orderChain` then keep all of them, leaf first.
 */
export function pfxToPem(buf: Buffer, passphrase?: string | null): ImportResult {
  const openssl = findOpenSsl()
  if (!openssl) return { certPem: null, keyPem: null, error: OPENSSL_MISSING, chainLength: 0 }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-pfx-'))
  const pfxPath = path.join(dir, 'in.pfx')

  try {
    fs.writeFileSync(pfxPath, buf, { mode: 0o600 })

    // ⛔ THE PASSPHRASE GOES THROUGH THE ENVIRONMENT, NEVER argv — a command
    // line is readable by any other process on the machine.
    //
    // ⛔ AND THE CHILD GETS A MINIMAL ENVIRONMENT, NOT A COPY OF OURS. A spread
    // of `process.env` would hand OpenSSL DATABASE_URL, NEXTAUTH_SECRET and
    // every ENTRA_* value, to a process that has no use for any of them and
    // which passes its environment on to anything it spawns. There is nothing
    // to weigh against that: OpenSSL is invoked by ABSOLUTE PATH, so it does
    // not even need PATH to be found. The allowlist is the minimum a Windows
    // process needs to start and find its own runtime — SystemRoot/windir for
    // the OS DLLs, TEMP/TMP for OpenSSL's scratch files, PATH for the
    // Git-for-Windows MSYS DLLs beside the exe, and OPENSSL_CONF so an operator
    // who set it deliberately gets the same behaviour here as in their shell.
    const env: Record<string, string> = { NV_PFX_PASS: passphrase == null ? '' : String(passphrase) }
    for (const name of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'PATH', 'Path', 'OPENSSL_CONF']) {
      const v = process.env[name]
      if (v != null) env[name] = v
    }
    const common = ['-in', pfxPath, '-passin', 'env:NV_PFX_PASS']

    const run = (args: string[]) =>
      execFileSync(openssl, args, {
        // ⛔ The cast is over the TYPE only. Next's ambient `ProcessEnv`
        // declares NODE_ENV as required, which would force this allowlist to
        // carry a variable OpenSSL has no use for just to satisfy a type — the
        // minimal-environment rule above is the point, so the type bends.
        env: env as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
        // ⛔ stderr is CAPTURED, not inherited. OpenSSL writes progress and
        // warnings there and it must not reach the app log, where it could echo
        // something derived from key material.
        stdio: ['ignore', 'pipe', 'pipe'],
      })

    let certOut: string
    let keyOut: string
    try {
      // ⛔ NO -clcerts. See this function's header.
      certOut = run(['pkcs12', ...common, '-nokeys'])
      keyOut = run(['pkcs12', ...common, '-nocerts', '-nodes'])
    } catch (err: unknown) {
      // ⛔ OpenSSL 3 refuses the older RC2/3DES encryption Windows still
      // produces unless `-legacy` is given. Retrying is the difference between
      // "works" and "your certificate is mysteriously rejected".
      try {
        certOut = run(['pkcs12', '-legacy', ...common, '-nokeys'])
        keyOut = run(['pkcs12', '-legacy', ...common, '-nocerts', '-nodes'])
      } catch (err2: unknown) {
        // ⛔ READ BOTH STDERRs, NOT JUST THE RETRY'S. The retry is exactly the
        // attempt whose failure says the least: the OpenSSL that ships with Git
        // for Windows has no legacy provider module, so `-legacy` never gets as
        // far as the password and always dies with "unable to load provider
        // legacy" — which then overwrites the first attempt's "Mac verify
        // error: invalid password?". That is the single most likely operator
        // mistake on the primary upload path, answered with a catch-all.
        const first = String((err as { stderr?: unknown })?.stderr ?? '')
        const retry = String((err2 as { stderr?: unknown })?.stderr ?? '')
        const combined = `${first}\n${retry}`

        // Checked FIRST and across BOTH attempts: a wrong password fails the
        // MAC check before any decryption, so whichever attempt got that far
        // reports it — usually attempt one, which the retry buries.
        if (/mac verify (error|failure)|invalid password|wrong password/i.test(combined)) {
          return {
            certPem: null,
            keyPem: null,
            error: 'That password did not open the .pfx file.',
            chainLength: 0,
          }
        }
        // ⛔ NAME THE MISSING PROVIDER RATHER THAN BLAMING THE PASSWORD. An
        // older Windows .pfx with an entirely CORRECT password lands here, and
        // telling that operator to check the password sends them to re-export
        // and retype it forever.
        if (/unable to load provider legacy|legacy\.dll|ossl-modules/i.test(retry)) {
          return {
            certPem: null,
            keyPem: null,
            error:
              "That .pfx uses older encryption (RC2/3DES) that this server's OpenSSL build cannot "
              + 'open — its legacy provider is not installed. The password is not the problem. '
              + 'Re-export the .pfx with AES encryption, or upload the certificate and key as '
              + 'separate PEM files.',
            chainLength: 0,
          }
        }
        return {
          certPem: null,
          keyPem: null,
          error:
            'The .pfx file could not be read. Check the password, and that the file is a PKCS#12 '
            + 'export containing both the certificate and its private key.',
          chainLength: 0,
        }
      }
    }

    // OpenSSL prints "Bag Attributes" blocks around each PEM. Keep only the
    // PEM — but ALL of it.
    const certs = orderChain(certificateBlocks(certOut))
    const key = privateKeyBlock(keyOut)

    if (certs.length === 0) {
      return {
        certPem: null,
        keyPem: null,
        error: 'No certificate was found inside that .pfx file.',
        chainLength: 0,
      }
    }
    if (!key) {
      return {
        certPem: null,
        keyPem: null,
        error:
          'That .pfx file contains a certificate but no private key. Re-export it with the '
          + 'private key included.',
        chainLength: 0,
      }
    }
    return { certPem: joinPem(certs), keyPem: key, error: null, chainLength: certs.length }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      certPem: null,
      keyPem: null,
      error: `The .pfx file could not be processed: ${message}`,
      chainLength: 0,
    }
  } finally {
    // ⛔ ALWAYS. The temp file is a private key on disk.
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

/**
 * Normalise whatever was uploaded into `{ certPem, keyPem }`.
 *
 * @param certBuf    the certificate, bundle or container
 * @param keyBuf     a separate key file, when the format needs one
 * @param passphrase for PKCS#12
 * @param chainBuf   an optional PEM bundle of intermediates. ⛔ THE DER PATH
 *                   NEEDS IT: a `.cer`/`.der` file holds exactly one
 *                   certificate, so without this there is no way to supply an
 *                   intermediate at all on the path a Windows certificate-store
 *                   export actually produces. Its blocks are merged and
 *                   re-ordered with the leaf's, so an operator cannot get the
 *                   order wrong either.
 */
export function importCertificate(
  certBuf: Buffer | null | undefined,
  keyBuf?: Buffer | null,
  passphrase?: string | null,
  chainBuf?: Buffer | null,
): ImportResult {
  if (!certBuf || certBuf.length === 0) {
    return { certPem: null, keyPem: null, error: 'No certificate file was provided.', chainLength: 0 }
  }

  const extraChain = chainBuf && chainBuf.length ? certificateBlocks(chainBuf.toString('utf8')) : []

  // ── PKCS#12 / DER: binary ────────────────────────────────────────────────
  // A DER certificate and a PFX both begin 0x30, so the certificate is tried
  // FIRST and PFX is the fallback — not the other way round.
  if (!looksLikePem(certBuf)) {
    let leaf: string
    try {
      leaf = derCertToPem(certBuf)
    } catch {
      // Not a DER certificate — it is a container.
      const imported = pfxToPem(certBuf, passphrase)
      if (!imported.certPem || extraChain.length === 0) return imported
      // ⛔ A chain bundle supplied alongside a .pfx is merged too. A Microsoft
      // CA export sometimes carries only the leaf, and the operator then has
      // the intermediate as a separate .crt — refusing to combine them would
      // send them back to OpenSSL, which is what this file exists to avoid.
      const merged = orderChain([...certificateBlocks(imported.certPem), ...extraChain])
      return { ...imported, certPem: joinPem(merged), chainLength: merged.length }
    }

    const certs = orderChain([leaf, ...extraChain])
    if (!keyBuf || keyBuf.length === 0) {
      return {
        certPem: joinPem(certs),
        keyPem: null,
        error:
          'That is a certificate only (.cer/.der). Add the matching private key file, or upload a '
          + '.pfx which contains both.',
        chainLength: certs.length,
      }
    }
    const keyText = looksLikePem(keyBuf) ? keyBuf.toString('utf8') : null
    const key = keyText ? privateKeyBlock(keyText) : null
    if (!key) {
      return {
        certPem: joinPem(certs),
        keyPem: null,
        error: 'The private key file is not in PEM format.',
        chainLength: certs.length,
      }
    }
    // ⛔ A key FILE may legitimately carry the certificate chain beside the key
    // (that is what a combined .pem is), so its certificate blocks are merged
    // rather than ignored.
    const withKeyFileCerts = orderChain([...certs, ...certificateBlocks(keyText as string)])
    return {
      certPem: joinPem(withKeyFileCerts),
      keyPem: key,
      error: null,
      chainLength: withKeyFileCerts.length,
    }
  }

  // ── PEM ──────────────────────────────────────────────────────────────────
  const text = certBuf.toString('utf8')
  // ⛔ EVERY BLOCK, NOT THE FIRST. This is the second half of bug (b): the
  // original took `certMatch[0]` from a non-greedy single match whenever the
  // file also held the key inline, which is the single commonest shape for a
  // `fullchain.pem` + key paste — so the one input most likely to CARRY a chain
  // was the one guaranteed to lose it.
  const certs = orderChain([...certificateBlocks(text), ...extraChain])
  if (certs.length === 0) {
    return {
      certPem: null,
      keyPem: null,
      error:
        'No certificate was found in that text. It should contain a block beginning '
        + '"-----BEGIN CERTIFICATE-----".',
      chainLength: 0,
    }
  }

  const keyFromSeparateFile =
    keyBuf && keyBuf.length ? privateKeyBlock(keyBuf.toString('utf8')) : null
  // A single PEM file often contains BOTH the certificate(s) and the key; a
  // separately uploaded key file wins, because an operator who supplied one
  // meant it.
  const key = keyFromSeparateFile || privateKeyBlock(text)

  return {
    certPem: joinPem(certs),
    keyPem: key,
    error: null,
    chainLength: certs.length,
  }
}

// ─── validation and description ─────────────────────────────────────────────

/** Days until a date, negative if already past. */
export function daysUntil(date: Date, now?: Date): number {
  const ref = now instanceof Date ? now : new Date()
  return Math.floor((date.getTime() - ref.getTime()) / 86400000)
}

export type CertificateDescription = {
  subject: string
  issuer: string
  sans: string[]
  validFrom: string
  validTo: string
  daysRemaining: number
  expired: boolean
  selfSigned: boolean
  /** How many certificates the PEM carried, and what they are. */
  chainLength: number
  chain: Array<{ subject: string; issuer: string }>
  parseError: string | null
}

function sansOf(x: crypto.X509Certificate): string[] {
  return String(x.subjectAltName || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function chainOf(pem: string): Array<{ subject: string; issuer: string }> {
  const out: Array<{ subject: string; issuer: string }> = []
  for (const block of certificateBlocks(pem)) {
    try {
      const x = new crypto.X509Certificate(block)
      out.push({
        subject: String(x.subject || '').replace(/\n/g, ', '),
        issuer: String(x.issuer || '').replace(/\n/g, ', '),
      })
    } catch {
      /* a block we cannot read is reported by the parse error above */
    }
  }
  return out
}

/**
 * Describe a certificate WITHOUT needing its key.
 *
 * ⛔ SEPARATE FROM validateCertificatePair ON PURPOSE. That function refuses a
 * missing key BEFORE it parses anything — right when installing a pair, and
 * wrong when reporting what is already deployed, where reusing it silently
 * returns nothing at all. GET needs this one; POST needs the other.
 *
 * ⛔ IT DESCRIBES THE LEAF AND COUNTS THE CHAIN. The leaf is what a browser
 * checks the hostname and expiry against, and the chain length is the one fact
 * that tells an operator whether the intermediate made it onto the server.
 */
export function describeCertificate(
  certPem: string | null | undefined,
  now?: Date,
): CertificateDescription | { parseError: string } | null {
  const cert = String(certPem || '').trim()
  if (!cert) return null
  const blocks = certificateBlocks(cert)
  let x: crypto.X509Certificate
  try {
    // The FIRST block is the leaf by TLS convention and by `orderChain`.
    x = new crypto.X509Certificate(blocks[0] || cert)
  } catch (err: unknown) {
    return { parseError: err instanceof Error ? err.message : String(err) }
  }
  const remaining = daysUntil(new Date(x.validTo), now)
  return {
    subject: String(x.subject || '').replace(/\n/g, ', '),
    issuer: String(x.issuer || '').replace(/\n/g, ', '),
    sans: sansOf(x),
    validFrom: x.validFrom,
    validTo: x.validTo,
    daysRemaining: remaining,
    expired: remaining < 0,
    selfSigned: String(x.subject) === String(x.issuer),
    chainLength: blocks.length,
    chain: chainOf(cert),
    parseError: null,
  }
}

export type CertificateValidation =
  | ({ valid: true; error: null } & CertificateDescription)
  | ({ valid: false; error: string } & Partial<CertificateDescription>)

/**
 * Validate a certificate + private key pair BEFORE it is written to disk.
 *
 * ⛔ THIS IS THE WHOLE POINT OF THE FEATURE. A certificate and a key that are
 * not each other's pair both parse perfectly; nothing goes wrong when the
 * operator clicks the button. It fails at the NEXT RESTART, which may be weeks
 * later during an unrelated upgrade, and it takes the console down — and by
 * then nobody connects the outage to a certificate install. `checkPrivateKey()`
 * is the check that makes that impossible, and it runs before a single byte is
 * written.
 */
export function validateCertificatePair(
  certPem: string | null | undefined,
  keyPem: string | null | undefined,
  now?: Date,
): CertificateValidation {
  const cert = String(certPem || '').trim()
  const key = String(keyPem || '').trim()

  if (!cert) return { valid: false, error: 'Paste the certificate (PEM).' }
  if (!key) return { valid: false, error: 'Paste the private key (PEM).' }

  // ⛔ Checked explicitly so the commonest paste mistakes get a sentence a
  // human can act on, rather than whatever OpenSSL's parser says about byte 0.
  if (!PEM_CERT.test(cert)) {
    return {
      valid: false,
      error:
        'That does not look like a certificate. It should begin with '
        + '"-----BEGIN CERTIFICATE-----". If you have a .pfx or .p12 file, upload it as the '
        + 'certificate file with its password instead.',
    }
  }
  if (PEM_CERT.test(key)) {
    return {
      valid: false,
      error: 'The private key box contains a certificate. The two boxes are the other way round.',
    }
  }
  if (!PEM_KEY.test(key)) {
    return {
      valid: false,
      error:
        'That does not look like a private key. It should begin with "-----BEGIN PRIVATE KEY-----" '
        + '(or "BEGIN RSA PRIVATE KEY").',
    }
  }
  // ⛔ An encrypted key cannot be loaded at boot without a passphrase, and
  // there is nowhere to prompt for one when a Windows service starts. Refused
  // here with an explanation rather than at 3am on the next restart.
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(key)) {
    return {
      valid: false,
      error:
        'This private key is passphrase-protected. NetVault starts as a Windows service and has '
        + 'nowhere to ask for a passphrase, so the key must be decrypted first '
        + '(openssl rsa -in enc.key -out plain.key).',
    }
  }

  const blocks = certificateBlocks(cert)
  let x509: crypto.X509Certificate
  try {
    x509 = new crypto.X509Certificate(blocks[0] || cert)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { valid: false, error: `The certificate could not be parsed: ${message}` }
  }
  // ⛔ EVERY block is parsed, not just the leaf. One unreadable intermediate in
  // a pasted bundle produces a file https.createServer refuses outright at the
  // next restart — the permanent-restart-loop failure `lib/tlsConfig.ts`
  // documents — and the leaf alone parsing says nothing about it.
  for (let i = 1; i < blocks.length; i += 1) {
    try {
      new crypto.X509Certificate(blocks[i])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        valid: false,
        error: `Certificate ${i + 1} of ${blocks.length} in that bundle could not be parsed: ${message}`,
      }
    }
  }

  let privateKey: crypto.KeyObject
  try {
    privateKey = crypto.createPrivateKey(key)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { valid: false, error: `The private key could not be parsed: ${message}` }
  }

  // ⛔ THE CHECK THAT MATTERS, AND IT RUNS BEFORE ANYTHING IS WRITTEN.
  let matches = false
  try {
    matches = x509.checkPrivateKey(privateKey)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { valid: false, error: `The key could not be checked against the certificate: ${message}` }
  }
  if (!matches) {
    return {
      valid: false,
      error:
        'This private key does not belong to this certificate. Installing them would break the '
        + 'console the next time it restarts.',
    }
  }

  const sans = sansOf(x509)
  const remaining = daysUntil(new Date(x509.validTo), now)
  const info: CertificateDescription = {
    subject: String(x509.subject || '').replace(/\n/g, ', '),
    issuer: String(x509.issuer || '').replace(/\n/g, ', '),
    sans,
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    daysRemaining: remaining,
    expired: remaining < 0,
    // Informational only — a self-signed certificate is a perfectly valid
    // thing to run on an internal appliance, it just produces a browser warning.
    selfSigned: String(x509.subject) === String(x509.issuer),
    chainLength: blocks.length,
    chain: chainOf(cert),
    parseError: null,
  }

  // ⛔ SPREAD FIRST, THEN OVERRIDE, on every refusal below. Written the other
  // way round `...info` carries its own `error: null` over the message and the
  // branch returns invalid-with-no-reason — a silent refusal the operator
  // cannot act on.
  if (info.expired) {
    return {
      ...info,
      valid: false,
      error:
        `This certificate expired on ${x509.validTo}. Installing it would make the console `
        + 'unreachable in every browser.',
    }
  }
  // ⛔ SANs are REQUIRED by every current browser — the CN is ignored
  // entirely. A certificate without them is not merely untrusted, it is
  // rejected.
  if (sans.length === 0) {
    return {
      ...info,
      valid: false,
      error:
        'This certificate has no Subject Alternative Names. Modern browsers ignore the Common '
        + 'Name entirely and will reject it. Ask for a certificate that lists the hostname '
        + 'and/or IP address you use to reach NetVault.',
    }
  }

  return { ...info, valid: true, error: null }
}
