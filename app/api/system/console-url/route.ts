import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import os from 'node:os'
import fs from 'node:fs'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { LINE_RE, readEnvFile } from '@/lib/envFile.ts'
import {
  rootEnvPath,
  shadowVerdict,
  standaloneEnvPath,
  writeManagedKey,
  type ShadowVerdict,
} from '@/lib/envTargets.ts'
import { decideConsoleUrl, DEFAULT_CONSOLE_PORT } from '@/lib/consoleUrl.ts'
import { nextAuthUrlMismatch, resolveTlsConfig } from '@/lib/tlsConfig.ts'

import { recordSystemChanges } from '@/lib/systemAudit.ts'

export const dynamic = 'force-dynamic'

// Settings → Console address. Reads and writes NEXTAUTH_URL.
//
// ⛔ EVERY JUDGEMENT IN THIS FEATURE LIVES IN `lib/consoleUrl.ts`, WHICH IS PURE
// AND TESTED. This file does I/O, checks the session inline (there is no
// `lib/rbac.ts` in this repo and there must not be one), and turns the three
// decisions into three HTTP answers. A route that re-derived `pointsHere`
// itself would be a second implementation of the lockout guard, and two
// implementations of one judgement eventually disagree — with this judgement
// the disagreement is "nobody can sign in".
//
// ⛔ GATED ON admin OR super_admin, AND THAT IS DELIBERATELY LOOSER THAN
// /api/system/entra. The console address is the address of THIS product; getting
// it wrong makes the console unreachable, which is an outage and is recoverable
// by editing a file on the server. The Entra tenant decides WHICH DIRECTORY MAY
// ISSUE IDENTITIES for the whole suite, which is a privilege escalation and is
// not recoverable by noticing. Same reasoning as the admin/super_admin split in
// `app/api/settings/route.ts`.
//
// ⛔ A RESTART IS ALWAYS REQUIRED AND IT IS SAID IN THE RESPONSE, NOT ONLY IN
// THE UI. NextAuth builds its options ONCE, at module load, from `process.env`.
// An administrator who saves this and does not know that concludes the setting
// did not take — and the next person to read the panel is a different client
// (curl, a sibling app, a future UI) that never saw the sentence the browser
// rendered. The fact belongs to the API.

const SERVICE_NAME = 'NetVault'

type SessionUser = { role?: string; name?: string }

function roleOf(session: unknown): string | undefined {
  return ((session as { user?: SessionUser } | null)?.user || {}).role
}

/**
 * This server's own addresses, or `null` when they could not be enumerated.
 *
 * ⛔ `null`, NEVER AN EMPTY ARRAY — and this is the one thing this route must
 * not get wrong. `hostPointsHere` compares the resolved addresses against this
 * list; with an empty list every comparison answers "no", so EVERY CORRECT
 * ADDRESS would be sent to the confirmation prompt and the lockout guard would
 * stop being evidence and become a dialog people learn to click through. An
 * unreadable interface list is our own failed read, not a fact about the
 * operator's DNS.
 *
 * ⛔ INTERNAL INTERFACES ARE INCLUDED. 127.0.0.1 genuinely is this server, so
 * excluding loopback would make `http://localhost:3000` — the address a
 * single-box install is reached on and the one the installer writes — resolve
 * "somewhere else" and demand confirmation.
 */
function localAddresses(): string[] | null {
  try {
    const out: string[] = []
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a?.address) out.push(a.address)
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * How many times a key appears in a file, so a duplicate can be refused BEFORE
 * the first write rather than halfway through the second one.
 *
 * ⛔ THIS IS A PRE-FLIGHT FOR A REPRODUCED FAILURE, not a hypothetical.
 * `setEnvValue` refuses a duplicated key — correctly, because which copy a
 * loader honours is a property of the loader — and NEXTAUTH_URL is written to
 * TWO files. A duplicate in the second one would refuse AFTER the first file
 * had already been rewritten, leaving the deploy source and the running file
 * disagreeing about the address of the console. Worse, the two readers here
 * genuinely differ: dotenv reads the LAST occurrence and
 * `Update-NetVault.ps1` reads the FIRST.
 */
function duplicateIn(text: string, key: string): boolean {
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line)
    if (m && m[1] === key) count += 1
  }
  return count > 1
}

type FileReport = {
  path: string
  role: 'deploy-source' | 'running'
  exists: boolean
  value: string | null
  /** Set when the file exists and could not be read or parsed. */
  error?: string
}

/**
 * What NEXTAUTH_URL is in each file we write, reported per file.
 *
 * ⛔ AN UNREADABLE FILE IS REPORTED AS UNREADABLE, NEVER AS UNSET. Showing an
 * empty box for a file we could not read invites an administrator to retype an
 * address that is already there, and the write would then be planned against a
 * file whose current contents are unknown.
 */
function readTarget(path: string, role: FileReport['role']): FileReport {
  if (!fs.existsSync(path)) return { path, role, exists: false, value: null }
  try {
    const { values } = readEnvFile(path)
    return { path, role, exists: true, value: (values.NEXTAUTH_URL || '').trim() || null }
  } catch (err: unknown) {
    return {
      path,
      role,
      exists: true,
      value: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * ⛔ THE THREE SHADOW STATES ARE REPORTED AS THREE STATES. `shadowed` means the
 * NSSM service environment pins NEXTAUTH_URL and WINS over both files, so this
 * save cannot take effect until an upgrade clears the pin — saying "saved" and
 * nothing else would be a success message for a change that will never happen.
 * `unknown` means we could not read the service environment (we are not on
 * Windows, or we lack permission) and it must NOT render as `clear`: "we did not
 * check" is not "nothing is pinned", and the difference decides whether the
 * operator's next restart changes anything.
 */
function shadowAnswer(shadow: ShadowVerdict) {
  if (shadow.state === 'shadowed') {
    return {
      shadow,
      shadowNote:
        `The ${shadow.serviceName} service environment pins NEXTAUTH_URL, and a service `
        + 'environment variable WINS over both environment files. This save is durable but it '
        + 'cannot take effect — not even after a restart — until that pin is removed, which the '
        + 'next suite upgrade does.',
      takesEffectOnRestart: false,
    }
  }
  if (shadow.state === 'unknown') {
    return {
      shadow,
      shadowNote:
        `Whether the ${SERVICE_NAME} service environment pins NEXTAUTH_URL could not be `
        + `determined (${shadow.reason}). If it does, it wins over both files and this change `
        + 'will not take effect. This is an unchecked condition, not a clean bill of health.',
      takesEffectOnRestart: null,
    }
  }
  return { shadow, shadowNote: null, takesEffectOnRestart: true }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = roleOf(session)
  if (role !== 'admin' && role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const deploySource = readTarget(rootEnvPath(), 'deploy-source')
  const running = readTarget(standaloneEnvPath(), 'running')
  // ⛔ SAVED AND RUNNING ARE DIFFERENT FACTS. The process read its environment
  // at startup, so a value saved a moment ago is not the value in force, and a
  // panel that shows one number cannot say which one it is showing.
  const runningValue = (process.env.NEXTAUTH_URL || '').trim() || null
  const savedValue = deploySource.value

  const tls = resolveTlsConfig(process.env)

  return NextResponse.json({
    saved: savedValue,
    running: runningValue,
    restartPending: savedValue !== runningValue,
    // ⛔ ALWAYS TRUE for a write through this route, stated here so a client
    // that only ever reads GET still learns it.
    restartRequiresService: SERVICE_NAME,
    files: [deploySource, running],
    ...shadowAnswer(shadowVerdict('NEXTAUTH_URL', SERVICE_NAME)),
    // The transport the server is ACTUALLY serving, which is what decides
    // whether the address must say http or https.
    transport: {
      status: tls.status,
      httpsPort: tls.httpsPort,
      httpPort: tls.httpPort,
      error: tls.error,
    },
    // ⛔ Compared against `status === 'active'`, not against "certs are
    // configured": in `failed` we are serving plaintext, so an https:// address
    // is just as broken there as in `disabled`.
    schemeMismatch: nextAuthUrlMismatch(tls, runningValue),
    examplePort: tls.httpsPort || DEFAULT_CONSOLE_PORT,
  })
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = roleOf(session)
  if (role !== 'admin' && role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as { url?: unknown; confirmed?: unknown }

  // ⛔ PASSED EXPLICITLY, FROM THE REAL TRANSPORT. `tlsActive` in
  // `lib/consoleUrl.ts` is TRI-STATE: `undefined` refuses NEITHER scheme, so a
  // caller that simply forgets this argument silently disables the strongest
  // refusal in the file — the scheme-versus-transport check, which is the
  // disagreement that breaks every sign-in with no error anywhere. It is read
  // from `resolveTlsConfig`'s `status === 'active'` rather than from "are
  // TLS_CERT_PATH and TLS_KEY_PATH set", because a `failed` load is serving
  // plaintext however configured it is.
  const tls = resolveTlsConfig(process.env)
  const tlsActive = tls.status === 'active'

  const decision = await decideConsoleUrl(body.url, {
    tlsActive,
    localAddresses: localAddresses(),
    examplePort: tls.httpsPort || DEFAULT_CONSOLE_PORT,
    confirmed: body.confirmed === true,
  })

  if (decision.decision === 'refuse') {
    return NextResponse.json({ error: decision.error, nothingChanged: true }, { status: 400 })
  }

  // ⛔ `confirm` BECOMES 409 + needsConfirmation, NEVER A SILENT ACCEPT. The
  // name resolves to a machine that is not this one, and if that is a typo then
  // after the restart nobody can sign in — including the person who made it, so
  // the fix is editing a file on the server rather than using this panel. The
  // operator has to say yes to that specifically; a second PUT carrying
  // `confirmed: true` proceeds. Collapsing this to an accept-with-a-warning
  // would put the warning in a response body nobody reads and the outage in
  // production.
  if (decision.decision === 'confirm') {
    return NextResponse.json(
      {
        needsConfirmation: true,
        reason: decision.reason,
        url: decision.url,
        warnings: decision.warnings,
        resolvedTo: decision.resolution.addresses,
        nothingChanged: true,
      },
      { status: 409 },
    )
  }

  // Pre-flight, across BOTH files, so a refusal cannot land mid-sequence.
  for (const path of [rootEnvPath(), standaloneEnvPath()]) {
    if (!fs.existsSync(path)) continue
    let text: string
    try {
      text = readEnvFile(path).text
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        {
          error:
            `${path} could not be read, so nothing was changed — a write against a file whose `
            + `current contents are unknown is the one thing this is built to prevent (${message}).`,
          nothingChanged: true,
        },
        { status: 500 },
      )
    }
    if (duplicateIn(text, 'NEXTAUTH_URL')) {
      return NextResponse.json(
        {
          error:
            `NEXTAUTH_URL appears more than once in ${path}, so a save would have no reliable `
            + 'effect — which copy a loader honours is a property of the loader, and here they '
            + 'genuinely differ (dotenv reads the last, the updater reads the first). Remove the '
            + 'duplicate line on the server first. Nothing was changed.',
          duplicateKeys: ['NEXTAUTH_URL'],
          duplicateIn: path,
          nothingChanged: true,
        },
        { status: 409 },
      )
    }
  }

  const write = writeManagedKey('NEXTAUTH_URL', decision.url, { serviceName: SERVICE_NAME })

  // ⛔ THE RETURN VALUE IS CHECKED. `writeManagedKey` and `setEnvValue` REPORT
  // failure, they do not throw it — a duplicated key, the 1 MB tripwire, an
  // unreadable file, a failed backup and a failed self-check are all
  // `{ ok: false }`. A try/catch around these calls inspecting nothing is how
  // SecVault answered 200 to every refused write.
  if (!write.ok) {
    return NextResponse.json(
      {
        error: `The console address could not be saved: ${write.error}`,
        // ⛔ WHICH FILES LANDED, because the operator is the person who has to
        // recover from a partial write — the deploy source is written first, so
        // a failure on the running file is durable-but-not-yet-live rather than
        // lost.
        files: write.results.map((r) => ({ path: r.path, role: r.role, ok: resultOk(r.result) })),
        nothingChanged: write.results.every((r) => !resultOk(r.result)),
      },
      { status: 500 },
    )
  }

  // ⛔ RECORDED AFTER THE WRITE SUCCEEDED. The console address is the field
  // that decides where sign-in callbacks land, and a wrong one makes the
  // console unreachable — so "who changed it, from what, to what" is exactly
  // what someone will need at the moment nobody can log in. Not a secret, so
  // the real values are recorded (lib/systemAudit.ts redacts only the Entra
  // fields).
  await recordSystemChanges((session.user as { id?: number | string } | undefined)?.id, [
    { key: 'NEXTAUTH_URL', from: write.previous, to: decision.url },
  ])

  const shadow = shadowAnswer(write.shadow)
  return NextResponse.json({
    ok: true,
    url: decision.url,
    // NEXTAUTH_URL is not a secret and the previous value is what an operator
    // needs in order to put it back by hand if the new one is wrong. ⛔ The
    // equivalent field is deliberately NOT forwarded by /api/system/entra —
    // there `previous` can be the old client secret.
    previous: write.previous,
    // Survives into the response even on a confirmed save, because the next
    // person to read Settings did not click the prompt.
    warnings: decision.warnings,
    resolvedTo: decision.resolution.addresses,
    pointsHere: decision.resolution.pointsHere,
    files: write.results.map((r) => ({
      path: r.path,
      role: r.role,
      ok: resultOk(r.result),
      skipped: r.result === 'skipped-missing',
      unchanged: r.result !== 'skipped-missing' && r.result.ok ? r.result.unchanged : null,
    })),
    ...shadow,
    // ⛔ IN THE RESPONSE, NOT ONLY IN THE UI. See this file's header.
    restartRequired: true,
    message:
      shadow.takesEffectOnRestart === false
        ? `Saved to both environment files, but the ${SERVICE_NAME} service environment pins `
          + 'NEXTAUTH_URL and wins over them, so restarting will not change the console address.'
        : `Saved. Restart the ${SERVICE_NAME} service to apply it — NextAuth reads its options `
          + 'once at startup, so sign-in keeps using the old address until then.',
  })
}

/** One place that knows what a per-file result means. */
function resultOk(result: { ok: boolean } | 'skipped-missing'): boolean {
  return result === 'skipped-missing' ? true : result.ok
}
