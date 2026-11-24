import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import os from 'node:os'
import fs from 'node:fs'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { readEnvFile } from '@/lib/envFile.ts'
import {
  duplicateIn,
  readServiceParams,
  resolveConsoleEnvTargets,
  rootEnvPath,
  shadowVerdict,
  standaloneEnvPath,
  writeConsoleKey,
  type ConsoleWriteResult,
  type EnvTarget,
  type ShadowVerdict,
} from '@/lib/envTargets.ts'
import {
  CONSOLES,
  CONSOLE_SLUGS,
  HUB_SLUG,
  consoleRestartServices,
  type ConsoleSlug,
} from '@/lib/consoles.ts'
import { decideConsoleUrl, deriveSiblingUrl, DEFAULT_CONSOLE_PORT } from '@/lib/consoleUrl.ts'
import { nextAuthUrlMismatch, resolveTlsConfig } from '@/lib/tlsConfig.ts'

import { recordSystemChanges } from '@/lib/systemAudit.ts'
import { HUB_PUBLIC_PORT, readTerminatorState } from '@/lib/terminatorState.ts'

export const dynamic = 'force-dynamic'

// Settings → Console address. Reads and writes `NEXTAUTH_URL` — for ALL FOUR
// consoles, not just the hub's own.
//
// ⛔ WHY THE HUB OWNS FOUR ADDRESSES AND NOT ONE. A satellite's `NEXTAUTH_URL`
// carries NO independent information: it is exactly `<hub scheme>://<hub
// host>:<that app's public port>` — one host, one transport (one TLS terminator
// fronts all four), four fixed ports. Because nothing in the product could set
// the other three, production drifted: the hub on the public FQDN while all
// three satellites were still on the raw install-time server IP, which leaks
// that IP into every NextAuth `callbackUrl` and sends users to an address the
// certificate does not cover. The satellites have no settings page of their own
// for this, so the per-app reporting below is the ONLY place an operator can see
// what those three values are.
//
// ⛔ EVERY JUDGEMENT IN THIS FEATURE LIVES IN `lib/consoleUrl.ts`, WHICH IS PURE
// AND TESTED. This file does I/O, checks the session inline (there is no
// `lib/rbac.ts` in this repo and there must not be one), and turns the three
// decisions into three HTTP answers. A route that re-derived `pointsHere`
// itself would be a second implementation of the lockout guard, and two
// implementations of one judgement eventually disagree — with this judgement
// the disagreement is "nobody can sign in".
//
// ⛔ AND THE DNS JUDGEMENT IS MADE ONCE, FOR ALL FOUR. The host is identical to
// the hub's BY CONSTRUCTION — it is derived from the hub's address, not typed
// per app — so `decideConsoleUrl`'s `pointsHere` reading and its single
// confirmation prompt cover every console. Four copies of one judgement would
// eventually disagree, and the operator would be asked the same question four
// times with four possible answers.
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
//
// ⛔ THE HUB'S OWN WRITE LANDS FIRST AND A SATELLITE FAILURE NEVER ROLLS IT
// BACK — the same rule `writeManagedKey` documents for its two files, one level
// up. Each console's write is individually verified and self-restoring, so a
// failure leaves that product's files intact; undoing the hub's verified write
// because LogVault could not be located would turn a partial success into a
// total one for no safety gain, and the partial state is fully reported below.

const HUB_SERVICE = CONSOLES[HUB_SLUG].service

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
 * save cannot take effect until the pin itself is changed — saying "saved" and
 * nothing else would be a success message for a change that will never happen.
 * `unknown` means we could not read the service environment (we are not on
 * Windows, or we lack permission) and it must NOT render as `clear`: "we did not
 * check" is not "nothing is pinned", and the difference decides whether the
 * operator's next restart changes anything.
 *
 * ⛔ IT TAKES THE SERVICE NAME. This used to interpolate one module-level
 * constant, which was correct while the hub was the only console this route
 * touched; reporting LogVault's pin as NetVault's would be a sentence naming the
 * wrong service to go and look at.
 */
function shadowAnswer(shadow: ShadowVerdict, serviceName: string) {
  if (shadow.state === 'shadowed') {
    return {
      shadow,
      shadowNote:
        `The ${shadow.serviceName} service environment pins NEXTAUTH_URL, and a service `
        + 'environment variable WINS over both environment files. Saving is durable, and this '
        + 'console only applies it if that pin is updated too.',
      takesEffectOnRestart: false,
    }
  }
  if (shadow.state === 'unknown') {
    return {
      shadow,
      shadowNote:
        `Whether the ${serviceName} service environment pins NEXTAUTH_URL could not be `
        + `determined (${shadow.reason}). If it does, it wins over both files and this change `
        + 'will not take effect. This is an unchecked condition, not a clean bill of health.',
      takesEffectOnRestart: null,
    }
  }
  return { shadow, shadowNote: null, takesEffectOnRestart: true }
}

/** The registry facts for all four consoles, read once and reused. */
type ServiceParams = { pins: string[] | null; appDirectory: string | null }

/**
 * ⛔ ONE REGISTRY READ PER SERVICE, IN PARALLEL, AND ASYNCHRONOUS. The GET and
 * the PUT both need the same two facts about the same four services, and a
 * blocking `reg query` per fact per app is eight synchronous child processes in
 * one handler — the shape that surfaces as database pool timeouts somewhere
 * unrelated ([[sync-exec-blocks-event-loop]]). Reading them once also means the
 * write cannot disagree with what the panel was just shown.
 */
async function readAllServiceParams(): Promise<Record<ConsoleSlug, ServiceParams>> {
  const entries = await Promise.all(
    CONSOLE_SLUGS.map(async (slug) => [slug, await readServiceParams(CONSOLES[slug].service)] as const),
  )
  return Object.fromEntries(entries) as Record<ConsoleSlug, ServiceParams>
}

/**
 * Where one console's two files are, or why we do not know.
 *
 * ⛔ THE HUB IS THE ONE CONSOLE THAT DOES NOT NEED THE REGISTRY. It is running
 * from its own repo, so it resolves its own files from the repo root — and the
 * satellite derivation (`parent(AppDirectory)`) would be WRONG for it, because
 * its AppDirectory is `<root>\.next\standalone` and the parent of that is the
 * build output `git clean` removes.
 */
function targetsFor(slug: ConsoleSlug, appDirectory: string | null): { targets: EnvTarget[] } | { error: string } {
  if (CONSOLES[slug].isHub) {
    return {
      targets: [
        { path: rootEnvPath(), role: 'deploy-source', optionalIfMissing: false },
        { path: standaloneEnvPath(), role: 'running', optionalIfMissing: true },
      ],
    }
  }
  if (appDirectory === null) return { error: 'not-located' }
  try {
    return { targets: resolveConsoleEnvTargets(slug, appDirectory) }
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

const NOT_LOCATED = (slug: ConsoleSlug) =>
  `Could not locate ${CONSOLES[slug].label}'s environment files: the ${CONSOLES[slug].service} `
  + "service's own install directory could not be read (this process may not be on the Windows "
  + 'host, may lack permission, or that service may not be installed). Its console address was '
  + 'NOT checked — this is an unknown, not a clean state.'

type AppReport = {
  slug: ConsoleSlug
  label: string
  service: string
  publicPort: number
  /**
   * ⛔ `true` OR `null`, AND NEVER `false`. We cannot tell "that console is not
   * installed" from "we could not read the registry" — `reg query` fails
   * identically for an absent service, an absent value and a refused
   * permission — so claiming `false` would be a guess presented as a fact. The
   * two states are "we have its install directory" and "we do not know".
   */
  locatable: boolean | null
  appDirectory: string | null
  note: string | null
  /** The deploy-source value: what the next deploy will propagate. */
  saved: string | null
  /**
   * What is in force. ⛔ FOR THE HUB THIS IS ITS OWN `process.env`, WHICH IS
   * PROOF; for a satellite it is the FILE that satellite's process loaded at
   * ITS startup, which is evidence and not proof — the hub cannot read another
   * process's environment. `runningSource` says which of the two it is, because
   * a panel that shows one value cannot say what it is showing.
   */
  running: string | null
  runningSource: 'process' | 'file' | null
  /** The address this console SHOULD have, derived from the hub's saved one. */
  expected: string | null
  /** ⛔ `null` when either side is unknown — never `false`. */
  matchesExpected: boolean | null
  files: FileReport[]
  shadow: ShadowVerdict
  shadowNote: string | null
  takesEffectOnRestart: boolean | null
  restartServices: string[]
}

function expectedFor(slug: ConsoleSlug, hubUrl: string | null): string | null {
  if (!hubUrl) return null
  if (CONSOLES[slug].isHub) return hubUrl
  const derived = deriveSiblingUrl(hubUrl, CONSOLES[slug].publicPort)
  return derived.ok ? derived.url : null
}

function buildAppReport(
  slug: ConsoleSlug,
  params: ServiceParams,
  hubUrl: string | null,
  hubFiles: FileReport[],
): AppReport {
  const facts = CONSOLES[slug]
  const shadow = shadowVerdict('NEXTAUTH_URL', facts.service, params.pins)
  const answer = shadowAnswer(shadow, facts.service)
  const expected = expectedFor(slug, hubUrl)
  const base = {
    slug,
    label: facts.label,
    service: facts.service,
    publicPort: facts.publicPort,
    appDirectory: params.appDirectory,
    expected,
    files: [] as FileReport[],
    shadow: answer.shadow,
    shadowNote: answer.shadowNote,
    takesEffectOnRestart: answer.takesEffectOnRestart,
    restartServices: consoleRestartServices(slug),
  }

  const resolved = targetsFor(slug, params.appDirectory)
  if ('error' in resolved) {
    return {
      ...base,
      locatable: null,
      note: resolved.error === 'not-located' ? NOT_LOCATED(slug) : resolved.error,
      saved: null,
      running: null,
      runningSource: null,
      matchesExpected: null,
    }
  }

  // The hub's own two files have already been read for the top-level payload;
  // reading them twice could report two different values in one response.
  const files = facts.isHub
    ? hubFiles
    : resolved.targets.map((t) => readTarget(t.path, t.role))
  const saved = (files.find((f) => f.role === 'deploy-source')?.value) ?? null
  const running = facts.isHub
    ? (process.env.NEXTAUTH_URL || '').trim() || null
    : (files.find((f) => f.role === 'running')?.value ?? null)

  return {
    ...base,
    locatable: true,
    note: null,
    files,
    saved,
    running,
    runningSource: facts.isHub ? 'process' : 'file',
    matchesExpected: expected && saved ? saved === expected : null,
  }
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

  const terminator = await readTerminatorState()
  const tls = resolveTlsConfig(process.env)
  const params = await readAllServiceParams()
  const apps = CONSOLE_SLUGS.map((slug) =>
    buildAppReport(slug, params[slug], savedValue, [deploySource, running]),
  )

  return NextResponse.json({
    saved: savedValue,
    running: runningValue,
    restartPending: savedValue !== runningValue,
    // ⛔ ALWAYS TRUE for a write through this route, stated here so a client
    // that only ever reads GET still learns it.
    restartRequiresService: HUB_SERVICE,
    files: [deploySource, running],
    ...shadowAnswer(shadowVerdict('NEXTAUTH_URL', HUB_SERVICE, params[HUB_SLUG].pins), HUB_SERVICE),
    // ⛔ ALL FOUR CONSOLES, EVERY TIME — including the three that have no
    // settings page of their own. A satellite still on the install-time IP while
    // the hub is on the public name is the production defect this feature
    // exists for, and `expected` vs `saved` per app is the only place it shows.
    apps,
    // The transport the server is ACTUALLY serving, which is what decides
    // whether the address must say http or https.
    // ⛔ THE TERMINATOR FRAME IS WHAT MAKES THESE PORTS MEAN ANYTHING.
    // 1.60.1 was supposed to add it here; what it actually added to this file
    // was the import line and nothing else, so this route kept reporting the
    // LOOPBACK port (13000 behind a cutover) as the HTTPS port — and the panel
    // printed it into the field's own placeholder, where an operator could
    // follow it and lock everyone out. See `examplePort` below.
    transport: {
      status: tls.status,
      httpsPort: tls.httpsPort,
      httpPort: tls.httpPort,
      error: tls.error,
      fronted: terminator.running,
      publicPort:
        terminator.running === true ? HUB_PUBLIC_PORT
        : terminator.running === false ? tls.httpsPort
        : null,
    },
    // ⛔ Compared against `status === 'active'`, not against "certs are
    // configured": in `failed` we are serving plaintext, so an https:// address
    // is just as broken there as in `disabled`.
    schemeMismatch: nextAuthUrlMismatch(tls, runningValue),
    // ⛔ THE PUBLIC PORT, NEVER THE LOOPBACK ONE. This is printed as the
    // field's hint AND its placeholder, so it is the number an operator is
    // most likely to actually type. `lib/consoleUrl.ts` now REFUSES a 1300x
    // port outright, so a suggested 13000 can no longer be accepted — but the
    // hint must still be the port a browser uses, not the one the terminator
    // proxies to. When the probe cannot tell, fall back to the hub's public
    // port rather than to this process's bound port.
    examplePort:
      terminator.running === true ? HUB_PUBLIC_PORT
      : terminator.running === false ? (tls.httpsPort || DEFAULT_CONSOLE_PORT)
      : DEFAULT_CONSOLE_PORT,
  })
}

/** One console's write, as the response reports it. */
function writeAnswer(result: ConsoleWriteResult, expected: string | null) {
  return {
    slug: result.slug,
    label: result.label,
    service: result.service,
    publicPort: result.publicPort,
    state: result.state,
    url: result.url,
    expected,
    // ⛔ DERIVED FROM WHETHER WE HAVE THE DIRECTORY, NOT FROM THE OUTCOME. A
    // refusal (a duplicated key, say) can happen on a console we DID locate,
    // and reading `locatable` off the state would mislabel it. `true | null`
    // only — `false` would claim "not installed", which an unreadable registry
    // cannot support.
    locatable: CONSOLES[result.slug].isHub || result.appDirectory !== null ? true : null,
    appDirectory: result.appDirectory,
    files: result.files,
    shadow: result.shadow,
    note: result.note,
    error: result.error,
    takesEffectOnRestart: result.takesEffectOnRestart,
    restartServices: result.restartServices,
  }
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
  //
  // ⛔ AND ONE VALUE IS CORRECT FOR ALL FOUR CONSOLES: one TLS terminator
  // fronts the whole suite, so there is one transport to disagree with.
  const tls = resolveTlsConfig(process.env)
  const tlsActive = tls.status === 'active'
  // ⛔ THE WRITE PATH NEEDS THE SAME FRAME AS THE READ PATH. This example is
  // what `lib/consoleUrl.ts` prints inside its refusal and confirmation
  // messages, so an operator correcting a rejected address is handed a port to
  // use — and the loopback port here is the lockout, offered at the exact
  // moment they are most likely to accept a suggestion. The GET handler was
  // fixed first and this one was missed; a seam test caught it.
  const putTerminator = await readTerminatorState()

  const decision = await decideConsoleUrl(body.url, {
    tlsActive,
    localAddresses: localAddresses(),
    examplePort:
      putTerminator.running === true ? HUB_PUBLIC_PORT
      : putTerminator.running === false ? (tls.httpsPort || DEFAULT_CONSOLE_PORT)
      : DEFAULT_CONSOLE_PORT,
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
  //
  // ⛔ ASKED ONCE, FOR ALL FOUR. The satellites' addresses are derived from this
  // host, so there is exactly one name to resolve and one question to ask.
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

  // ⛔ THE HUB'S OWN PRE-FLIGHT STAYS A HARD REFUSAL, ACROSS BOTH ITS FILES, SO
  // A REFUSAL CANNOT LAND MID-SEQUENCE. `setEnvValue` refuses a duplicated key
  // — correctly, because which copy a loader honours is a property of the
  // loader — and NEXTAUTH_URL is written to TWO files. A duplicate in the second
  // one would refuse AFTER the first had been rewritten, leaving the deploy
  // source and the running file disagreeing about the address of the console.
  // Worse, the two readers here genuinely differ: dotenv reads the LAST
  // occurrence and `Update-NetVault.ps1` reads the FIRST.
  //
  // ⛔ THE SATELLITES RUN THE SAME SCAN, BUT PER APP AND INSIDE THE FAN-OUT
  // (`writeConsoleKey`), so one satellite's duplicated key refuses THAT app
  // and leaves the hub's already-landed write and the other two alone.
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

  // Read every console's registry facts BEFORE any write, so the write cannot
  // be planned against a different reading than the one reported.
  const params = await readAllServiceParams()

  /**
   * ⛔ THE HUB FIRST, AND SEQUENTIALLY. The hub is the console the operator is
   * holding; its write is the one that must land, and the three derived ones
   * follow from it. Sequential rather than parallel because each write rewrites
   * a file holding every secret in that install and verifies itself afterwards
   * — four of those at once on one disk is a race nobody needs.
   */
  const hub = await writeConsoleKey(HUB_SLUG, 'NEXTAUTH_URL', decision.url, {
    // ⛔ NO EXPLICIT TARGETS FOR THE HUB, AND NO CAST TO PRETEND THERE ARE. The
    // hub is running from its own repo, so `writeConsoleKey` resolves its two
    // files the way every other hub write already does (`resolveEnvTargets`) —
    // which is also the only derivation that is correct for it.
    readPins: () => params[HUB_SLUG].pins,
  })

  // ⛔ THE RETURN VALUE IS CHECKED. `writeConsoleKey`/`writeManagedKey`/
  // `setEnvValue` REPORT failure, they do not throw it — a duplicated key, the
  // 1 MB tripwire, an unreadable file, a failed backup and a failed self-check
  // are all `{ ok: false }`. A try/catch around these calls inspecting nothing
  // is how SecVault answered 200 to every refused write.
  //
  // ⛔ AND THE HUB'S FAILURE STOPS THE FAN-OUT. Every satellite address is
  // derived from the hub's, so writing three satellites to an address the hub
  // itself refused would point the whole suite at a value nothing holds.
  if (hub.state === 'failed') {
    return NextResponse.json(
      {
        error: hub.error,
        // ⛔ WHICH FILES LANDED, because the operator is the person who has to
        // recover from a partial write — the deploy source is written first, so
        // a failure on the running file is durable-but-not-yet-live rather than
        // lost.
        files: hub.files,
        nothingChanged: hub.files.length === 0 || hub.files.every((f) => !f.ok),
      },
      { status: 500 },
    )
  }

  const results: ConsoleWriteResult[] = [hub]
  for (const slug of CONSOLE_SLUGS) {
    if (slug === HUB_SLUG) continue
    const derived = deriveSiblingUrl(decision.url, CONSOLES[slug].publicPort)
    if (!derived.ok) {
      results.push({
        slug,
        label: CONSOLES[slug].label,
        service: CONSOLES[slug].service,
        publicPort: CONSOLES[slug].publicPort,
        state: 'failed',
        url: null,
        appDirectory: params[slug].appDirectory,
        files: [],
        shadow: { state: 'unknown', reason: 'nothing was written, so nothing was measured' },
        pin: null,
        takesEffectOnRestart: null,
        previous: null,
        note: null,
        error: derived.error,
        restartServices: consoleRestartServices(slug),
      })
      continue
    }
    results.push(
      await writeConsoleKey(slug, 'NEXTAUTH_URL', derived.url, {
        // ⛔ THE FACTS COME FROM THE ONE READING TAKEN ABOVE, so the fan-out
        // cannot locate a console somewhere the report named somewhere else.
        locate: () => params[slug].appDirectory,
        readPins: () => params[slug].pins,
      }),
    )
  }

  // ⛔ RECORDED AFTER THE WRITE SUCCEEDED, AND PER CONSOLE. The console address
  // is the field that decides where sign-in callbacks land, and a wrong one
  // makes the console unreachable — so "who changed it, from what, to what" is
  // exactly what someone will need at the moment nobody can log in. Not a
  // secret, so the real values are recorded (lib/systemAudit.ts redacts only the
  // Entra fields).
  //
  // ⛔ THE KEY STAYS `NEXTAUTH_URL` AND THE CONSOLE GOES IN THE PREFIX. The
  // redaction in `lib/systemAudit.ts` is keyed on the KEY — deliberately, so a
  // value is never judged by its shape — and its own tests state that only
  // `AUDITED_KEYS` are ever passed in. A per-app key like
  // `NEXTAUTH_URL (logvault)` would quietly break that invariant and would miss
  // any future redaction rule for this key. The hub's `field_name` is unchanged
  // (`system_setting:NEXTAUTH_URL`), so existing audit rows and the Audit Log
  // page keep reading the same string.
  const actorId = (session.user as { id?: number | string } | undefined)?.id
  for (const r of results) {
    if (r.url === null) continue
    await recordSystemChanges(
      actorId,
      [{ key: 'NEXTAUTH_URL', from: r.previous, to: r.url }],
      r.slug === HUB_SLUG ? 'system_setting' : `system_setting:${r.slug}`,
    )
  }

  const apps = results.map((r) => writeAnswer(r, expectedFor(r.slug, decision.url)))
  // ⛔ THE SERVICES THAT HAVE TO RESTART ARE DERIVED FROM WHAT ACTUALLY LANDED,
  // never from the list of four. Offering to restart a console whose write was
  // refused — or one we could not even locate — would interrupt it for no
  // change at all. SpanVault contributes TWO services, because
  // `spanvault/api/rbacScope.js` puts NEXTAUTH_URL into the Express API's SSRF
  // allow-list and that process loads the same file.
  //
  // ⛔ THE TEST IS "DID FILES LAND", NOT "IS THE STATE `saved`". A console whose
  // PIN STATUS could not be read is `unknown` — and its files were still
  // written, so it still needs the restart; whether that restart will apply the
  // value is the unknown, and withholding the restart would guarantee it does
  // not. `url` is non-null for exactly the consoles something was written for.
  const changedApps = results.filter((r) => r.url !== null)
  const restartServices = [...new Set(changedApps.flatMap((r) => r.restartServices))]

  const hubShadow = shadowAnswer(hub.shadow, HUB_SERVICE)
  return NextResponse.json({
    ok: true,
    url: decision.url,
    // NEXTAUTH_URL is not a secret and the previous value is what an operator
    // needs in order to put it back by hand if the new one is wrong. ⛔ The
    // equivalent field is deliberately NOT forwarded by /api/system/entra —
    // there `previous` can be the old client secret.
    previous: hub.previous,
    // Survives into the response even on a confirmed save, because the next
    // person to read Settings did not click the prompt.
    warnings: decision.warnings,
    resolvedTo: decision.resolution.addresses,
    pointsHere: decision.resolution.pointsHere,
    files: hub.files,
    shadow: hub.shadow,
    // ⛔ THE TOP-LEVEL VERDICT IS THE HUB'S OWN, TAKEN FROM THE HUB'S WRITE
    // RATHER THAN RE-DERIVED. A second derivation here could say "it will take
    // effect" while the per-app row said it would not.
    shadowNote: hub.note ?? hubShadow.shadowNote,
    takesEffectOnRestart: hub.takesEffectOnRestart,
    apps,
    restartServices,
    // ⛔ IN THE RESPONSE, NOT ONLY IN THE UI. See this file's header.
    restartRequired: true,
    message:
      hub.takesEffectOnRestart === false
        ? `Saved to both environment files, but the ${HUB_SERVICE} service environment pins `
          + 'NEXTAUTH_URL and wins over them, so restarting will not change the console address.'
        : `Saved${restartServices.length > 1 ? ` for ${changedApps.length} consoles` : ''}. `
          + `Restart ${restartServices.join(', ')} to apply it — NextAuth reads its options once `
          + 'at startup, so sign-in keeps using the old address until then.',
  })
}
