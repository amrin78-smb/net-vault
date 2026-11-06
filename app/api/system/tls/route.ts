import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import fs from 'node:fs'
import path from 'node:path'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import {
  repoRoot,
  shadowVerdict,
  writeManagedKey,
  type ShadowVerdict,
} from '@/lib/envTargets.ts'
import {
  describeTlsStatus,
  nextAuthUrlMismatch,
  resolveTlsConfig,
  type TlsConfig,
} from '@/lib/tlsConfig.ts'
import {
  describeCertificate,
  importCertificate,
  validateCertificatePair,
} from '@/lib/certImport.ts'

import { recordSystemChanges } from '@/lib/systemAudit.ts'
import { HUB_PUBLIC_PORT, readTerminatorState } from '@/lib/terminatorState.ts'

export const dynamic = 'force-dynamic'

// Settings → HTTPS. Reports the transport and installs a certificate pair.
//
// ⛔ THE PRIVATE KEY IS NEVER RETURNED, BY ANY HANDLER, IN ANY SHAPE. GET
// reports what the certificate IS — subject, SANs, expiry, chain — and nothing
// about the key beyond whether a file is present. A key path is a filename, not
// key material, and the operator needs to know which file an install would
// replace.
//
// ⛔ GATED ON admin OR super_admin, the same gate as
// /api/system/console-url and deliberately looser than /api/system/entra. A bad
// certificate is an OUTAGE — recoverable by restoring a file on the server, and
// bounded by this route's own refusals. The Entra tenant is a PRIVILEGE
// ESCALATION, which is not bounded by anything and not recoverable by noticing.
//
// ⛔ THREE TRANSPORT STATES, NEVER TWO, and `failed` must never read like
// `disabled`: `disabled` is how the whole suite has shipped for its entire life
// and is not an error, while `failed` means the operator asked for TLS and is
// not getting it. `describeTlsStatus` is the one place that wording lives.

const SERVICE_NAME = 'NetVault'

type SessionUser = { role?: string; name?: string }

function roleOf(session: unknown): string | undefined {
  return ((session as { user?: SessionUser } | null)?.user || {}).role
}

/**
 * Where a certificate goes on THIS installation.
 *
 * ⛔ WRITE WHERE THE SERVER READS. SecVault's route reported `config.certPath`
 * in its GET and then wrote unconditionally to `<cwd>\certs\secvault.crt`. On an
 * install with `TLS_CERT_PATH=C:\PKI\...` — a shape `lib/tlsConfig.ts`
 * explicitly supports — installing a renewal through the panel wrote it to a
 * path nothing reads, told the operator to restart, and after the restart the
 * console served the OLD certificate with nothing anywhere explaining why. That
 * is a certificate expiring in production while the console insists it was
 * replaced. The CONFIGURED path wins; the default below is only for an
 * installation that has no configured path at all.
 */
function targetPaths(config: TlsConfig): { certPath: string; keyPath: string } {
  const dir = path.join(repoRoot(), 'certs')
  return {
    certPath: config.certPath || path.join(dir, 'netvault.crt'),
    keyPath: config.keyPath || path.join(dir, 'netvault.key'),
  }
}

function shadowNote(key: string, shadow: ShadowVerdict): string | null {
  if (shadow.state === 'shadowed') {
    return (
      `The ${shadow.serviceName} service environment pins ${key}, and a service environment `
      + 'variable WINS over both environment files, so this path cannot take effect — not even '
      + 'after a restart — until that pin is removed, which the next suite upgrade does.'
    )
  }
  if (shadow.state === 'unknown') {
    return (
      `Whether the ${SERVICE_NAME} service environment pins ${key} could not be determined `
      + `(${shadow.reason}). If it does, it wins over both files. This is an unchecked `
      + 'condition, not a clean bill of health.'
    )
  }
  return null
}

/**
 * ⛔ THE THREE SHADOW STATES ARE REPORTED AS THREE STATES, and `unknown` is
 * never rendered as `clear`.
 */
function shadowAnswer(verdicts: Record<string, ShadowVerdict>) {
  const notes = Object.entries(verdicts)
    .map(([k, v]) => shadowNote(k, v))
    .filter(Boolean) as string[]
  const states = Object.values(verdicts).map((v) => v.state)
  return {
    shadow: verdicts,
    shadowNotes: notes,
    takesEffectOnRestart: states.includes('shadowed')
      ? false
      : states.includes('unknown')
        ? null
        : true,
  }
}

function measureShadows(): Record<string, ShadowVerdict> {
  return {
    TLS_CERT_PATH: shadowVerdict('TLS_CERT_PATH', SERVICE_NAME),
    TLS_KEY_PATH: shadowVerdict('TLS_KEY_PATH', SERVICE_NAME),
  }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = roleOf(session)
  if (role !== 'admin' && role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const config = resolveTlsConfig(process.env)
  const consoleUrl = (process.env.NEXTAUTH_URL || '').trim() || null
  // ⛔ WHICH PROCESS IS ACTUALLY TERMINATING TLS. config.httpsPort is read from
  // THIS process's PORT, which behind the front door is its loopback port -
  // so without this the panel reports "Serving HTTPS on port 13000" about a
  // process serving plain HTTP on 13000. See transportPresentation's `fronted`.
  const terminator = await readTerminatorState()

  // ⛔ describeCertificate, NOT validateCertificatePair. The latter refuses a
  // missing key BEFORE it parses anything — correct when installing a pair, and
  // it silently returns nothing when simply reporting what is deployed. The
  // private key is never read on this path, because nothing here needs it.
  let certificate: ReturnType<typeof describeCertificate> = null
  let certReadError: string | null = null
  if (config.certPath) {
    try {
      certificate = describeCertificate(fs.readFileSync(config.certPath, 'utf8'))
    } catch (err: unknown) {
      certificate = null
      certReadError = err instanceof Error ? err.message : String(err)
    }
  }

  return NextResponse.json({
    status: config.status,
    // The one-line summary, so a client that renders nothing else still cannot
    // mistake `failed` for `disabled`.
    summary: describeTlsStatus(config),
    error: config.error,
    httpsPort: config.httpsPort,
    httpPort: config.httpPort,
    certPath: config.certPath,
    keyPath: config.keyPath,
    certPresent: Boolean(config.certPath && fs.existsSync(config.certPath)),
    // ⛔ Whether a key FILE is there. Never the key, never its contents, never
    // its length.
    keyPresent: Boolean(config.keyPath && fs.existsSync(config.keyPath)),
    certReadError,
    certificate,
    consoleUrl,
    // ⛔ Compared against `status === 'active'`, not against "certs are
    // configured". In `failed` we are serving plaintext, so an https:// console
    // address is just as broken there as in `disabled` — and `failed` is
    // precisely the state an operator lands in after uploading a bad
    // certificate.
    nextAuthUrlMismatch: nextAuthUrlMismatch(config, consoleUrl),
    // The terminator holds the certificate, so "which service must restart to
    // serve a new one" depends on this too.
    terminator: terminator.state,
    fronted: terminator.running,
    publicPort: terminator.running ? HUB_PUBLIC_PORT : config.httpsPort,
    installTargets: targetPaths(config),
    ...shadowAnswer(measureShadows()),
  })
}

/**
 * Install a certificate + key.
 *
 * ⛔ NORMALISE, VALIDATE, ASK, BACK UP, WRITE — in that order and never any
 * other. Validation is what makes this feature safe at all: a certificate and a
 * key that are not each other's pair both parse perfectly and fail only at the
 * NEXT RESTART, which may be weeks later during an unrelated upgrade, and by
 * then nobody connects the outage to a certificate install.
 * `checkPrivateKey()` runs in `lib/certImport.ts` before a single byte reaches
 * disk.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = roleOf(session)
  if (role !== 'admin' && role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    certificate?: unknown
    privateKey?: unknown
    certificateB64?: unknown
    privateKeyB64?: unknown
    chainB64?: unknown
    chain?: unknown
    passphrase?: unknown
    replace?: unknown
  }

  // ⛔ ACCEPT WHAT A WINDOWS ADMINISTRATOR ACTUALLY HAS: pasted PEM, a
  // `.cer`/`.der` plus its key, or a `.pfx` with a passphrase. A Microsoft CA
  // issues .pfx and "export the certificate" offers .cer; almost nothing on
  // Windows produces the PEM pair node wants. Demanding three OpenSSL commands
  // first is how this feature goes unused and the console stays on plain HTTP.
  //
  // Binary files arrive base64-encoded, because a .pfx cannot survive JSON any
  // other way; pasted PEM arrives as plain text.
  let certInput: string | null = null
  let keyInput: string | null = null
  let chainLength = 0

  const b64 = (v: unknown): Buffer | null =>
    typeof v === 'string' && v.trim() !== '' ? Buffer.from(v, 'base64') : null
  const text = (v: unknown): Buffer | null =>
    typeof v === 'string' && v.trim() !== '' ? Buffer.from(v, 'utf8') : null

  const certBuf = b64(body.certificateB64) || text(body.certificate)
  const keyBuf = b64(body.privateKeyB64) || text(body.privateKey)
  const chainBuf = b64(body.chainB64) || text(body.chain)

  if (!certBuf) {
    return NextResponse.json(
      {
        error:
          'No certificate was supplied. Paste the PEM, or upload a .cer/.der with its key, or a '
          + '.pfx with its password.',
        nothingChanged: true,
      },
      { status: 400 },
    )
  }

  const imported = importCertificate(
    certBuf,
    keyBuf,
    typeof body.passphrase === 'string' ? body.passphrase : null,
    chainBuf,
  )
  // ⛔ A NORMALISATION ERROR THAT STILL PRODUCED A KEY IS NOT FATAL (it is
  // advice, e.g. "that is a certificate only" when a key did in fact arrive
  // separately); one that produced no key is.
  if (imported.error && !imported.keyPem) {
    return NextResponse.json(
      { error: imported.error, certificate: null, nothingChanged: true },
      { status: 400 },
    )
  }
  certInput = imported.certPem
  keyInput = imported.keyPem
  chainLength = imported.chainLength

  const info = validateCertificatePair(certInput, keyInput)
  if (!info.valid) {
    // ⛔ NOTHING HAS BEEN WRITTEN AT THIS POINT, and the message is the one the
    // validator produced — written for an operator, not a developer.
    return NextResponse.json(
      { error: info.error, certificate: null, nothingChanged: true },
      { status: 400 },
    )
  }

  // Resolved ONCE and used for the existence check, the backup, the write and
  // the response, so the path the operator is told about cannot drift from the
  // path written.
  const config = resolveTlsConfig(process.env)
  const { certPath, keyPath } = targetPaths(config)

  // ⛔ AN EXISTING CERTIFICATE IS NEVER OVERWRITTEN WITHOUT THE OPERATOR ASKING
  // FOR IT. Replacing the pair this console is reached through is not a safe
  // default for a request that may have been fired by a half-filled form, a
  // retry or a stale tab — and the certificate being replaced may be the only
  // copy of a CA-issued one on the box. 409 + `needsConfirmation`, in the same
  // shape as /api/system/console-url's lockout prompt; a second POST carrying
  // `replace: true` proceeds. (The backup below is a safety net, not a
  // substitute for asking: it tells the operator afterwards what happened, and
  // the question is what lets them decide beforehand.)
  const existing = [certPath, keyPath].filter((p) => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  })
  if (existing.length > 0 && body.replace !== true) {
    let currentCert: ReturnType<typeof describeCertificate> = null
    try {
      currentCert = describeCertificate(fs.readFileSync(certPath, 'utf8'))
    } catch {
      currentCert = null
    }
    return NextResponse.json(
      {
        needsConfirmation: true,
        reason:
          'A certificate is already installed at this location. Replacing it changes how every '
          + 'user reaches this console after the next restart. Confirm to replace it — the files '
          + 'being replaced are backed up alongside themselves first.',
        existingFiles: existing,
        currentCertificate: currentCert,
        // What WOULD be installed, so the operator is comparing two
        // certificates rather than agreeing to an unseen one.
        incomingCertificate: {
          subject: info.subject,
          issuer: info.issuer,
          sans: info.sans,
          validFrom: info.validFrom,
          validTo: info.validTo,
          daysRemaining: info.daysRemaining,
          selfSigned: info.selfSigned,
          chainLength,
        },
        nothingChanged: true,
      },
      { status: 409 },
    )
  }

  const backups: string[] = []
  try {
    for (const dir of [path.dirname(certPath), path.dirname(keyPath)]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }

    // ⛔ A TIMESTAMPED BACKUP OF WHATEVER IS THERE NOW, NEXT TO EACH FILE. The
    // certificate and the key can legitimately live in different directories,
    // so each backup follows its OWN original rather than assuming one folder.
    // An operator who installs the wrong certificate must be able to get back
    // to a working console without going back to their CA.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const [src, label] of [
      [certPath, 'crt'],
      [keyPath, 'key'],
    ] as const) {
      if (!fs.existsSync(src)) continue
      const base = path.basename(src).replace(/\.[^.]*$/, '')
      const dest = path.join(path.dirname(src), `${base}.${stamp}.bak.${label}`)
      fs.copyFileSync(src, dest)
      backups.push(dest)
    }

    // ⛔ THE NORMALISED PEM, NOT THE RAW REQUEST BODY. A .pfx or .cer upload has
    // already been converted; writing the raw body here would store a binary
    // container as though it were a certificate, producing a file that passes
    // every check in this route and breaks the next restart. The normalised PEM
    // is also the one that carries the FULL CHAIN — see lib/certImport.ts.
    fs.writeFileSync(certPath, String(certInput).trim() + '\n', 'utf8')
    // ⛔ 0600 where the platform honours it. On Windows the installer's ACL is
    // what actually protects this; the mode is belt and braces for any other
    // host.
    fs.writeFileSync(keyPath, String(keyInput).trim() + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: `The certificate could not be written: ${message}`, backups },
      { status: 500 },
    )
  }

  // ⛔ A CERTIFICATE ON DISK IS NOT TLS. On a `disabled` install TLS_CERT_PATH
  // and TLS_KEY_PATH are unset, so `lib/tlsConfig.ts` resolves `disabled` and
  // the server serves plain HTTP however good the files are. Telling that
  // operator "restart to begin serving it" is simply false, and they would
  // restart the console — a real interruption — to get exactly the transport
  // they already had. So the paths are WRITTEN, through the managed-key writer
  // that puts them in both the deploy source and the running file.
  const certWrite = writeManagedKey('TLS_CERT_PATH', certPath, { serviceName: SERVICE_NAME })
  const keyWrite = writeManagedKey('TLS_KEY_PATH', keyPath, { serviceName: SERVICE_NAME })
  const envErrors = [certWrite, keyWrite].filter((w) => !w.ok).map((w) => w.error)

  const shadow = shadowAnswer({
    TLS_CERT_PATH: certWrite.shadow,
    TLS_KEY_PATH: keyWrite.shadow,
  })

  // ⛔ THE TRANSPORT IS ABOUT TO CHANGE, SO THE CONSOLE ADDRESS HAS TO CHANGE
  // WITH IT. After the restart TLS is active; a NEXTAUTH_URL still saying
  // `http://` then issues the sign-in cookie for an origin the browser is not
  // on and every login silently fails, with no error in the browser, in the app
  // log, or anywhere else. The operator cannot be left to discover that: the
  // console-address panel REFUSES an http:// address once TLS is active, so
  // changing it is a required second step and is named here as one.
  const consoleUrl = (process.env.NEXTAUTH_URL || '').trim() || null
  const consoleUrlAfterRestart = nextAuthUrlMismatch(
    { ...config, status: 'active' },
    consoleUrl,
  )

  // ⛔ RECORDED AFTER THE CERTIFICATE IS ON DISK AND THE PATHS ARE WRITTEN.
  // Replacing the certificate that terminates TLS for every console is worth a
  // row; the PATHS are recorded (they are not secrets and are what an operator
  // needs to find the backup), never any key material — lib/systemAudit.ts
  // redacts the Entra fields, and nothing here passes it key bytes at all.
  // `config` was resolved at the top of this handler, BEFORE the write, so its
  // paths are genuinely the previous ones.
  await recordSystemChanges((session.user as { id?: number | string } | undefined)?.id, [
    { key: 'TLS_CERT_PATH', from: config.certPath, to: certPath },
    { key: 'TLS_KEY_PATH', from: config.keyPath, to: keyPath },
  ])

  return NextResponse.json({
    ok: true,
    certPath,
    keyPath,
    backups,
    // How many certificates were actually installed. ⛔ 1 MEANS LEAF-ONLY,
    // which validates in a browser that has the intermediate cached and fails
    // in strict clients — an intermittent, per-client failure that gets blamed
    // on the client. Reported so it is visible before it is a support call.
    chainLength,
    chainOnly: chainLength === 1,
    certificate: {
      subject: info.subject,
      issuer: info.issuer,
      sans: info.sans,
      validFrom: info.validFrom,
      validTo: info.validTo,
      daysRemaining: info.daysRemaining,
      selfSigned: info.selfSigned,
      chain: info.chain,
      // ⛔ IT BELONGS IN HERE TOO, NOT ONLY AT THE TOP LEVEL. The panel renders
      // this object, so omitting the count made every install report "Chain
      // length unknown" — and `chainPresentation` correctly treats unknown as a
      // WARNING. A real three-certificate chain (leaf + RapidSSL intermediate +
      // DigiCert root) was reported to an operator as possibly leaf-only,
      // observed on production 2026-11-06. The number was one level up the
      // whole time.
      chainLength,
    },
    // The env write is reported separately from the file write: the files can
    // land while the env write fails, and that partial state is benign but must
    // not be hidden.
    envWritten: envErrors.length === 0,
    envError: envErrors.length > 0 ? envErrors.join(' ') : null,
    previousStatus: config.status,
    ...shadow,
    // ⛔ ALWAYS, AND IN THE RESPONSE. node reads certificate material ONCE, at
    // startup. The files on disk have changed but the running process is still
    // holding the OLD certificate in memory, and without this sentence an
    // operator reasonably concludes the new certificate is live and is then
    // baffled that the browser keeps showing the old one.
    restartRequired: true,
    restartRequiresService: SERVICE_NAME,
    consoleUrl,
    consoleUrlActionRequired: consoleUrlAfterRestart,
    message:
      envErrors.length > 0
        ? `Certificate installed to ${certPath}, but the TLS paths could not be saved to the `
          + `environment files (${envErrors.join(' ')}), so a restart will not enable HTTPS until `
          + 'that is fixed on the server.'
        : shadow.takesEffectOnRestart === false
          ? `Certificate installed to ${certPath}, but the ${SERVICE_NAME} service environment `
            + 'pins the TLS paths and wins over both environment files, so restarting will not '
            + 'enable HTTPS until that pin is removed.'
          : `Certificate installed to ${certPath}. Restart the ${SERVICE_NAME} service to begin `
            + 'serving it.',
  })
}
