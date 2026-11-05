import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import fs from 'node:fs'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { readEnvFile } from '@/lib/envFile.ts'
import {
  rootEnvPath,
  shadowVerdict,
  standaloneEnvPath,
  writeManagedKey,
  type ShadowVerdict,
} from '@/lib/envTargets.ts'
import {
  ENTRA_FIELD_LABELS,
  ENTRA_KEYS,
  applyEntraWrites,
  duplicateEntraKeys,
  entraRestartPending,
  entraWriteFailureAnswer,
  isEntraConfigured,
  normaliseEntraInput,
  planEntraWrite,
  type EntraKey,
  type EntraWriteResult,
} from '@/lib/entraSettings.ts'

import { recordSystemChanges, AUDITED_KEYS } from '@/lib/systemAudit.ts'

export const dynamic = 'force-dynamic'

// Settings → Single sign-on. Reads and writes ENTRA_TENANT_ID,
// ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET.
//
// ⛔ GATED ON super_admin ONLY — STRICTER THAN /api/system/console-url, AND
// DELIBERATELY SO. Whoever sets the tenant decides WHICH DIRECTORY IS TRUSTED
// TO ISSUE IDENTITIES, and NetVault is the hub: `NEXTAUTH_SECRET` signs the
// cross-app handoff tokens every satellite verifies, so this setting does not
// decide who may sign in to NetVault, it decides who may sign in to NocVault.
// An `admin` who could point ENTRA_TENANT_ID at a tenant they control, map a
// group they own to super_admin and sign in would have escalated past every
// other guard in the product without ever touching the Users page. Configuring
// the issuer cannot be a LESSER privilege than creating an account, and
// creating an account is super_admin here.
//
// ⛔ THE SECRET IS WRITE-ONLY AND IS NEVER RETURNED, BY ANY HANDLER, IN ANY
// SHAPE. GET reports only whether one is SET. The saved-versus-running
// comparison needs both secrets, so it happens on the server in
// `entraRestartPending` and only the FIELD LABEL of a difference travels.
//
// ⛔ `previous` IS NOT FORWARDED — NOT AT THE TOP LEVEL AND NOT INSIDE
// `results[]`. `writeManagedKey` returns the value it replaced, and for
// ENTRA_CLIENT_SECRET that IS the old secret; `setEnvValue`'s per-file results
// carry it too. `app/api/system/console-url/route.ts` forwards its `previous`
// quite correctly, because a console address is not a credential — so this
// route must not be written by copying that one. The writer adapter below
// constructs the four fields `applyEntraWrites` needs, FIELD BY FIELD, rather
// than spreading, which is what makes the omission impossible to lose in a
// later edit.
//
// ⛔ EVERY REFUSAL, THE WRITE ORDER AND THE RESTART COMPARISON LIVE IN
// `lib/entraSettings.ts`, which is pure and tested. This file does I/O and
// checks the session inline; there is no `lib/rbac.ts` in this repo and there
// must not be one.
//
// ⛔ THESE THREE LIVE IN ENVIRONMENT FILES RATHER THAN `app_settings`, AND THAT
// IS FORCED RATHER THAN CHOSEN. NextAuth builds its provider array ONCE, at
// module load, from `process.env` — a tenant stored in a table is not available
// at that moment, so the provider could not be registered at all. The restart
// that implies is stated in the response rather than left to be discovered.

const SERVICE_NAME = 'NetVault'

type SessionUser = { role?: string; name?: string; id?: number | string }

function roleOf(session: unknown): string | undefined {
  return ((session as { user?: SessionUser } | null)?.user || {}).role
}

/**
 * The Redirect URI the Entra app registration must carry.
 *
 * ⛔ DERIVED, NEVER TYPED. It has to match what NextAuth sends byte for byte,
 * and a mismatch fails on MICROSOFT'S side — the user sees an AADSTS error page
 * and nothing reaches our logs at all, so there is no trace on this server of
 * the commonest setup mistake in the feature. Deriving it removes the one place
 * a typo could live, and showing the exact string rather than describing it
 * removes the second.
 *
 * ⛔ THE PROVIDER ID `entra` IS LOAD-BEARING. NextAuth builds the callback path
 * from the provider's own id, so this string is only correct while the provider
 * registered in `app/api/auth/[...nextauth]/route.ts` is called `entra`.
 */
function redirectUriFor(consoleUrl: string | null | undefined): string | null {
  const base = String(consoleUrl || '').trim().replace(/\/+$/, '')
  if (!base) return null
  return `${base}/api/auth/callback/entra`
}

function shadowNote(key: EntraKey, shadow: ShadowVerdict): string | null {
  if (shadow.state === 'shadowed') {
    return (
      `The ${shadow.serviceName} service environment pins ${key}, and a service environment `
      + 'variable WINS over both environment files, so this value cannot take effect — not even '
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
 * ⛔ THE THREE SHADOW STATES ARE REPORTED AS THREE STATES, per key, and
 * `unknown` is never rendered as `clear`.
 */
function shadowAnswer(verdicts: Record<EntraKey, ShadowVerdict>) {
  const notes = ENTRA_KEYS.map((k) => shadowNote(k, verdicts[k])).filter(Boolean) as string[]
  return {
    shadow: verdicts,
    shadowNotes: notes,
    // `false` = pinned and so unreachable; `null` = we could not tell; `true` =
    // the files are what will be read.
    takesEffectOnRestart: ENTRA_KEYS.some((k) => verdicts[k].state === 'shadowed')
      ? false
      : ENTRA_KEYS.some((k) => verdicts[k].state === 'unknown')
        ? null
        : true,
  }
}

function measureShadows(): Record<EntraKey, ShadowVerdict> {
  return {
    ENTRA_TENANT_ID: shadowVerdict('ENTRA_TENANT_ID', SERVICE_NAME),
    ENTRA_CLIENT_ID: shadowVerdict('ENTRA_CLIENT_ID', SERVICE_NAME),
    ENTRA_CLIENT_SECRET: shadowVerdict('ENTRA_CLIENT_SECRET', SERVICE_NAME),
  }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // ⛔ super_admin only. See this file's header.
  if (roleOf(session) !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const file = rootEnvPath()
  let saved: Record<string, string>
  try {
    saved = readEnvFile(file).values || {}
  } catch (err: unknown) {
    // ⛔ UNREADABLE IS NOT "UNCONFIGURED". Reporting an empty form for a file we
    // could not read invites an administrator to retype a tenant that is
    // already there, and the write would then be planned against a file whose
    // current contents are unknown.
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      {
        error:
          `${file} could not be read, so the current single sign-on settings are unknown `
          + `(${message}).`,
      },
      { status: 500 },
    )
  }

  const val = (k: EntraKey) => (saved[k] || '').trim()
  const restart = entraRestartPending(saved, process.env)
  const runningConsoleUrl = (process.env.NEXTAUTH_URL || '').trim() || null

  let savedConsoleUrl: string | null = null
  try {
    savedConsoleUrl = (readEnvFile(file).values.NEXTAUTH_URL || '').trim() || null
  } catch {
    savedConsoleUrl = null
  }

  return NextResponse.json({
    // ⛔ WHETHER EACH VALUE IS SET — and for the secret that is ALL that is
    // reported. The two ids are GUIDs naming a directory and an app
    // registration; they are not credentials and the panel has to pre-fill
    // them, so they travel. The secret does not, ever.
    tenantIdSet: val('ENTRA_TENANT_ID') !== '',
    clientIdSet: val('ENTRA_CLIENT_ID') !== '',
    clientSecretSet: val('ENTRA_CLIENT_SECRET') !== '',
    tenantId: val('ENTRA_TENANT_ID'),
    clientId: val('ENTRA_CLIENT_ID'),

    // ⛔ ALL THREE ARE REQUIRED TOGETHER. Any one blank means not configured:
    // no sign-in button renders and nothing is logged as a fault, which is the
    // intended behaviour of a half-filled form, not a bug to work around.
    configured: isEntraConfigured(saved),
    runningConfigured: isEntraConfigured(process.env as Record<string, string | undefined>),

    // ⛔ SAVED vs RUNNING ARE DIFFERENT FACTS AND IT COMPARES VALUES, NOT
    // CONFIGURED-NESS. Both are `true` whenever Entra is already live, so a
    // boolean comparison reports "nothing pending" for every edit to a working
    // tenant — including a client-secret ROTATION, where the administrator then
    // believes the new credential is in force while the running process still
    // presents the REVOKED one to Microsoft and every sign-in fails with
    // nothing on screen saying why. ⛔ COMPUTED HERE because the comparison
    // needs the secret and the secret may not leave the server; only the field
    // LABEL of a difference travels.
    restartPending: restart.pending,
    restartPendingFields: restart.fields,
    restartRequiresService: SERVICE_NAME,

    // ⛔ THE EXACT STRING TO REGISTER, derived from the console address. The
    // running value is the one in force right now, so it is the one that must
    // be registered for sign-in to work today; when a console-address save is
    // still awaiting a restart, the address it will become is reported
    // SEPARATELY rather than silently replacing it — registering only the
    // future one breaks sign-in until the restart, and registering only the
    // current one breaks it after.
    redirectUri: redirectUriFor(runningConsoleUrl),
    redirectUriAfterRestart:
      savedConsoleUrl && savedConsoleUrl !== runningConsoleUrl
        ? redirectUriFor(savedConsoleUrl)
        : null,
    consoleUrl: runningConsoleUrl,
    consoleUrlConfigured: Boolean(runningConsoleUrl),
    ...shadowAnswer(measureShadows()),
  })
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (roleOf(session) !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const input = normaliseEntraInput(body)
  const file = rootEnvPath()

  // ⛔ THE FILE IS READ BEFORE ANYTHING IS PLANNED, and an unreadable one is
  // refused. A write made against a file whose current contents are unknown is
  // the one thing `lib/envFile.ts` exists to prevent.
  let current: { text: string; values: Record<string, string> }
  try {
    current = readEnvFile(file)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      {
        error:
          `${file} could not be read, so nothing was changed. Check it on the server before `
          + `saving again (${message}).`,
        nothingChanged: true,
      },
      { status: 500 },
    )
  }

  // ⛔ PRE-FLIGHT, SO A REFUSAL CANNOT LAND MID-SEQUENCE — and it is checked in
  // BOTH target files, because a duplicate in the runtime file would refuse
  // AFTER the deploy source had already been rewritten, in the middle of the
  // off → change → on sequence. `.env.example` ships these keys blank and
  // operators add them by hand; doing both duplicates the key, which is a
  // reproduced case rather than a hypothetical one.
  for (const path of [file, standaloneEnvPath()]) {
    if (!fs.existsSync(path)) continue
    let text: string
    try {
      text = readEnvFile(path).text
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        {
          error: `${path} could not be read, so nothing was changed (${message}).`,
          nothingChanged: true,
        },
        { status: 500 },
      )
    }
    const duplicates = duplicateEntraKeys(text)
    if (duplicates.length > 0) {
      return NextResponse.json(
        {
          error:
            `${duplicates.join(', ')} appear more than once in ${path}, so a save would have no `
            + 'reliable effect — which copy a loader honours is a property of the loader, and '
            + 'here they genuinely differ (dotenv reads the last, the updater reads the first). '
            + 'Remove the duplicate lines on the server first. Nothing was changed.',
          duplicateKeys: duplicates,
          duplicateIn: path,
          nothingChanged: true,
        },
        { status: 409 },
      )
    }
  }

  // ⛔ A BOOLEAN, NEVER THE SECRET. `planEntraWrite` only needs to know whether
  // a stored secret exists, so that a blank secret box can mean "keep the one
  // you already have" — handing it the value would put a credential into the
  // decision layer for no gain, and the decision layer is the module whose
  // whole discipline is that values do not travel through it.
  const plan = planEntraWrite(input, {
    storedSecret: (current.values.ENTRA_CLIENT_SECRET || '').trim() !== '',
  })
  if (!plan.ok) {
    return NextResponse.json(
      { error: plan.error, field: plan.field, nothingChanged: true },
      { status: plan.status || 400 },
    )
  }

  // ⛔ THE ADAPTER IS THE REDACTION BOUNDARY. `writeManagedKey` returns
  // `previous` at the top level AND a `previous` inside each per-file
  // `SetEnvResult`; for ENTRA_CLIENT_SECRET both are the old secret. The four
  // fields `applyEntraWrites` needs are named one by one — no spread, nothing
  // retained — so the full result object never reaches a variable that could
  // later be put in a response body.
  const shadows: Partial<Record<EntraKey, ShadowVerdict>> = {}
  const fileOutcomes: Array<{ key: EntraKey; path: string; role: string; ok: boolean }> = []

  const writer = (key: EntraKey, value: string): EntraWriteResult => {
    const r = writeManagedKey(key, value, { serviceName: SERVICE_NAME })
    shadows[key] = r.shadow
    for (const f of r.results) {
      fileOutcomes.push({
        key,
        path: f.path,
        role: f.role,
        ok: f.result === 'skipped-missing' ? true : f.result.ok,
      })
    }
    // `unchanged` only when every file that was actually written says so; a
    // claimed no-op while something moved would be a false all-clear, and
    // `applyEntraWrites` keys the "changed" report off this.
    const written = r.results.filter((f) => f.result !== 'skipped-missing')
    const unchanged =
      r.ok
      && written.length > 0
      && written.every((f) => f.result !== 'skipped-missing' && f.result.ok && f.result.unchanged)
    const backup =
      r.results
        .map((f) => (f.result === 'skipped-missing' ? null : f.result.backupPath || null))
        .find((p) => p) || null
    return { ok: r.ok, error: r.error, unchanged, backupPath: backup }
  }

  // ⛔ THE RETURN VALUE IS CHECKED. `setEnvValue` REPORTS its failures, it does
  // not throw them — a duplicated key, the 1 MB tripwire, an unreadable file, a
  // line break in the value, a failed backup or a failed self-check are all
  // `{ ok: false }`. SecVault wrapped three bare calls in a try/catch and
  // inspected nothing, so every refused write answered HTTP 200 with the keys
  // reported as written.
  const outcome = applyEntraWrites(plan.writes, writer)
  if (!outcome.ok) {
    // ⛔ `entraWriteFailureAnswer` carries LABELS AND KEY NAMES ONLY, and says
    // which of the two states a stopped sequence is in: nothing landed, or
    // single sign-on is now OFF. That is a property of the off → change → on
    // order rather than a guess about it — the tenant blank is always the first
    // write, so the moment anything has landed the feature is off.
    const answer = entraWriteFailureAnswer(outcome)
    return NextResponse.json(
      { ...answer, files: fileOutcomes, restartRequired: !answer.nothingChanged },
      { status: 500 },
    )
  }

  // ⛔ AUDITED AFTER THE WRITE SUCCEEDED, NEVER BEFORE IT. A row written
  // up-front would record a change that a later refusal rolled back, and an
  // audit trail that reports things which did not happen is worse than none.
  //
  // ⛔ ONLY THE SESSION'S id IS THE ACTOR — never anything from the body.
  //
  // ⛔ All three Entra fields record PRESENCE ONLY (lib/systemAudit.ts). The
  // comparison that decides whether to record happens on the RAW values, so a
  // secret ROTATION is captured even though both sides redact identically.
  // This is the one change in the product that can escalate past every other
  // guard: whoever sets the tenant decides which directory issues identities.
  await recordSystemChanges(
    (session.user as SessionUser | undefined)?.id,
    AUDITED_KEYS.filter((k) => (ENTRA_KEYS as readonly string[]).includes(k)).map((k) => ({
      key: k,
      from: current.values[k],
      to: plan.writes.filter((w) => w.key === k).slice(-1)[0]?.value ?? current.values[k],
    })),
  )

  const shadow = shadowAnswer({ ...measureShadows(), ...shadows } as Record<EntraKey, ShadowVerdict>)
  const consoleUrl = (process.env.NEXTAUTH_URL || '').trim() || null

  return NextResponse.json({
    ok: true,
    disabled: plan.disabling,
    // ⛔ An explicitly CLEARED secret leaves a tenant with no credential, which
    // is a legitimate request and leaves SSO off — said plainly rather than
    // reported as a successful configure.
    configured: plan.configured,
    // ⛔ KEY NAMES AND LABELS, NEVER VALUES. Already deduped by
    // `applyEntraWrites` (ENTRA_TENANT_ID is written twice by design, blanked
    // first and restored last), so this is not deduped again here — a second
    // `new Set` would be a guard that cannot fire.
    written: outcome.landed,
    writtenFields: outcome.landed.map((k) => ENTRA_FIELD_LABELS[k]),
    changed: outcome.changed,
    changedFields: outcome.changed.map((k) => ENTRA_FIELD_LABELS[k]),
    files: fileOutcomes,
    ...shadow,
    // ⛔ ALWAYS TRUE, IN THE RESPONSE RATHER THAN ONLY IN THE UI. NextAuth
    // builds its provider array once at startup, so nothing saved here is in
    // force until the service restarts — and an administrator who does not know
    // that concludes the feature is broken when the sign-in button does not
    // appear.
    restartRequired: true,
    restartRequiresService: SERVICE_NAME,
    // ⛔ Re-derived and returned on the write too, because the registration has
    // to be done in the portal before the restart is worth making.
    redirectUri: redirectUriFor(consoleUrl),
    message:
      shadow.takesEffectOnRestart === false
        ? `Saved to both environment files, but the ${SERVICE_NAME} service environment pins at `
          + 'least one of these keys and wins over them, so restarting will not switch single '
          + 'sign-on on.'
        : plan.disabling
          ? `Single sign-on settings cleared. Restart ${SERVICE_NAME} to apply.`
          : plan.configured
            ? `Saved. Register ${redirectUriFor(consoleUrl) || 'the redirect URI'} in the Entra `
              + `app registration, then restart ${SERVICE_NAME} — the sign-in button appears `
              + 'after the restart.'
            : 'Saved, but single sign-on is OFF because no client secret is stored. Paste the '
              + `secret value to switch it on, then restart ${SERVICE_NAME}.`,
  })
}
