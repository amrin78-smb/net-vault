//
// lib/entraSettings.ts — validating and sequencing a change to WHICH DIRECTORY
// IS TRUSTED TO ISSUE IDENTITIES for this suite.
//
// NetVault is the hub: it owns SSO for all four apps, and `NEXTAUTH_SECRET`
// signs the cross-app handoff tokens every satellite verifies. So the directory
// configured here does not decide who can sign in to NetVault — it decides who
// can sign in to NocVault. Pointing `ENTRA_TENANT_ID` at a directory somebody
// else controls is the single widest authority in this product, which is why
// the route that calls this is gated on `super_admin` (NetVault's roles are
// `super_admin`, `admin`, `site_admin`, `viewer`).
//
// ⛔ THIS MODULE MAKES NO AUTHORISATION DECISION. The route does that inline,
// as every NetVault route does — there is no `lib/rbac.ts` here and this file
// must not grow one. What lives here is the DECISION LAYER: normalise the
// submitted values, refuse the ones that cannot work, decide the ORDER the
// three keys are written in, apply that order through an INJECTED writer, and
// compare saved-vs-running. No file I/O, no HTTP, no database.
//
// Ported from secvault/lib/entraSettings.js, which earned these guards by
// shipping three defects that nothing could test: a refused write reported as
// HTTP 200, a disable path the form could not reach, and a restart banner that
// compared configured-NESS instead of VALUES so a credential ROTATION never
// showed it. All three are shapes a behavioural test catches and a source scan
// does not — which is the whole argument for this file being pure and separate.
//
// ⛔ WHAT MAY TRAVEL AND WHAT MAY NOT. Two of the shapes below are
// RESPONSE-SHAPED — a route may hand them to a client — and the rest are
// INSTRUCTION-SHAPED and must not leave the server:
//
//   response-shaped : planEntraWrite's refusals, applyEntraWrites' outcome,
//                     entraWriteFailureAnswer, entraRestartPending
//   instruction-shaped : planEntraWrite's `writes` — it carries the SECRET
//                     VALUE, because that value is what the writer has to
//                     write. It is the one place a secret appears in anything
//                     this module returns, and it exists to be consumed by
//                     applyEntraWrites, never serialised into a response.
//
// ⛔ THE CLIENT SECRET IS WRITE-ONLY. Nothing here reports it back, and nothing
// here forwards the writer's `previous` — which, for `ENTRA_CLIENT_SECRET`, IS
// the old secret. `lib/envFile.ts`'s `setEnvValue` returns `previous`, and
// `lib/envTargets.ts`'s `writeManagedKey` returns it again at the top level of
// its own result; the console-address panel forwards it deliberately (the old
// URL is the recovery information there). Copying that pattern here would put a
// live credential in an HTTP response body, so `applyEntraWrites` PICKS the
// fields it needs from a writer result and never spreads one.

// ⛔ ONE PARSER FOR THE ENV GRAMMAR, NOT TWO. `lib/envFile.ts`'s LINE_RE carries
// a trailing-\r fix and an `export ` tolerance, and it is the regex the
// authoritative writer uses to find and replace a key. A second regex for the
// same grammar is a second parser that would eventually disagree with the
// authoritative one — and the disagreement would show up as a duplicate-key
// scan that reports clean on a file `setEnvValue` then refuses, mid-sequence.
import { LINE_RE } from './envFile.ts'

/** The three keys, in no particular order — the ORDER that matters is below. */
export const ENTRA_KEYS = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET'] as const

export type EntraKey = (typeof ENTRA_KEYS)[number]

/**
 * The human label for each key, used in the restart banner and in a partial
 * write report.
 *
 * ⛔ LABELS TRAVEL, VALUES DO NOT — this map is the whole reason the secret can
 * be compared at all. `entraRestartPending` compares the saved and running
 * secrets here, on the server, and returns only the LABEL of a difference. A
 * digest would also work and would be no safer: the comparison is between two
 * values the process already holds, and the disclosure to guard against is the
 * response body.
 */
export const ENTRA_FIELD_LABELS: Record<EntraKey, string> = {
  ENTRA_TENANT_ID: 'Directory (tenant) ID',
  ENTRA_CLIENT_ID: 'Application (client) ID',
  ENTRA_CLIENT_SECRET: 'Client secret',
}

/** A GUID, which is what both the tenant and client ids are. */
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * An obviously-fake GUID, shown in the refusal so an operator can see the shape
 * expected. ⛔ It is a CONSTANT, never the value they submitted: a wrong tenant
 * id is very often a secret pasted into the wrong box, and echoing the input to
 * explain its shape would put that secret in a response body.
 */
const EXAMPLE_GUID = '11111111-2222-3333-4444-555555555555'

export type EntraInput = {
  tenantId: string
  clientId: string
  /** `undefined` = leave the stored secret alone. See below. */
  clientSecret: string | undefined
  blankedByTrim: boolean
}

/**
 * Normalise the three values out of a request body.
 *
 * ⛔ THE SECRET IS TRIMMED, AND IN SECVAULT IT DELIBERATELY WAS NOT AT FIRST.
 * The old reasoning was that a secret may legitimately contain unusual
 * characters so nothing should touch it — but `parseEnv` in `lib/envFile.ts`
 * TRIMS ON READ, so surrounding whitespace could never have survived the round
 * trip anyway. Keeping it only meant storing bytes that would never be read
 * back. Worse, a LEADING OR TRAILING NEWLINE — which is what a paste from a
 * text editor or a `cat`-ed file produces — hits `setEnvValue`'s line-break
 * refusal, and while that refusal was being discarded the operator was told the
 * secret had saved. So the trim is what makes the common paste work; it mangles
 * nothing, because the untrimmed form was unreadable.
 *
 * ⛔ A WHOLLY-WHITESPACE SECRET IS NOT A CLEAR. It trims to '', which is the
 * explicit "remove the stored secret" instruction, and inferring that from what
 * is far more likely a bad paste would delete a working credential. It is
 * reported as `blankedByTrim` and refused by `planEntraWrite`.
 */
export function normaliseEntraInput(body: unknown): EntraInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const tenantId = typeof b.tenantId === 'string' ? b.tenantId.trim() : ''
  const clientId = typeof b.clientId === 'string' ? b.clientId.trim() : ''
  // ⛔ THREE-WAY, AND THE THIRD STATE IS LOAD-BEARING. `undefined` means LEAVE
  // THE STORED SECRET ALONE, '' means CLEAR IT, anything else means replace it.
  // Collapsing the first two would make every edit of the tenant id wipe the
  // secret, because the form cannot pre-fill a value it is never given — the
  // field is write-only, so a blank box and a cleared box look identical on the
  // wire and only the body's SHAPE can tell them apart.
  const raw = typeof b.clientSecret === 'string' ? b.clientSecret : undefined
  const clientSecret = raw === undefined ? undefined : raw.trim()
  return {
    tenantId,
    clientId,
    clientSecret,
    blankedByTrim: raw !== undefined && raw !== '' && clientSecret === '',
  }
}

/**
 * Is Entra configured, given a set of env values?
 *
 * ⛔ ALL THREE ARE REQUIRED TOGETHER, and this is the one place that says so.
 * Any one blank means Entra is NOT configured: the provider is not registered,
 * no sign-in button renders, and nothing is logged as a fault — that is the
 * normal state of an install that does not use Entra, not an error. Registering
 * an OAuth provider unconfigured would render a button that cannot complete a
 * sign-in, which is worse than no button; absent is the honest state.
 *
 * ⛔ TURNING SSO OFF MEANS CLEARING ALL THREE. Clearing some of them is a
 * HALF-CONFIGURATION, not a disable — see `planEntraWrite`, which refuses to
 * infer one from the other.
 */
export function isEntraConfigured(values: Record<string, string | undefined> | null | undefined): boolean {
  return ENTRA_KEYS.every((k) => String((values && values[k]) || '').trim() !== '')
}

/**
 * Which keys appear MORE THAN ONCE in the file. Pre-flight, because a duplicate
 * is the one `setEnvValue` refusal that is a property of the FILE rather than of
 * the value — so it is knowable before any write, and knowing it before the
 * FIRST write is what keeps a refusal from landing halfway through the sequence
 * below.
 *
 * ⛔ THIS IS A REPRODUCED CASE, NOT A HYPOTHETICAL, AND IT IS WORSE HERE THAN IN
 * SECVAULT. `.env.example` ships keys blank and operators add them by hand;
 * doing both duplicates the key. In SecVault every save then answered 200 while
 * changing nothing. In NetVault the two readers disagree as well: dotenv reads
 * the LAST occurrence and `Update-NetVault.ps1` reads the FIRST, so a duplicated
 * key makes the running value and the next deploy's value different by
 * construction.
 */
export function duplicateEntraKeys(
  text: string | null | undefined,
  keys: readonly EntraKey[] = ENTRA_KEYS,
): EntraKey[] {
  const counts = new Map<string, number>()
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = LINE_RE.exec(line)
    if (m && (keys as readonly string[]).includes(m[1])) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1)
    }
  }
  return keys.filter((k) => (counts.get(k) || 0) > 1)
}

/** One planned write. ⛔ INSTRUCTION-SHAPED: `value` may be the secret. */
export type EntraWrite = { key: EntraKey; value: string }

export type EntraPlan =
  | {
      ok: true
      disabling: boolean
      configured: boolean
      secretCleared: boolean
      secretReplaced: boolean
      writes: EntraWrite[]
    }
  | {
      ok: false
      status: number
      error: string
      /** The LABEL of the offending field, so the panel can mark the box. Never its value. */
      field: string | null
    }

/**
 * Turn a normalised body into a validated, ordered list of writes.
 *
 * ⛔ THE ORDER IS OFF → CHANGE → ON, AND THAT IS THE WHOLE SAFETY PROPERTY.
 * SecVault's route used to write the secret FIRST and claim in a comment that "a
 * partial failure leaves a tenant WITHOUT a usable secret, which is refused at
 * sign-in, rather than a secret sitting beside a tenant id that no longer
 * matches it." The claim was the exact INVERSE of what the code produced: a
 * refused tenant write left the NEW SECRET beside the OLD TENANT ID, and because
 * Entra is only considered configured when all three are non-empty — and all
 * three already are on any machine where Entra is live — no partial sequence
 * could ever turn the feature off. The comment asserted the property; the code
 * produced its opposite; nothing could tell, because none of it was testable.
 *
 * So the sequence MAKES that state unreachable rather than asserting it is:
 *
 *   1. ENTRA_TENANT_ID = ''      the feature is now definitively OFF
 *   2. ENTRA_CLIENT_SECRET       (only when the body supplied one)
 *   3. ENTRA_CLIENT_ID
 *   4. ENTRA_TENANT_ID = <new>   the feature is ON again, last
 *
 * Any failure after step 1 leaves the tenant blank, so no sign-in button
 * renders, local accounts keep working, and the operator is told which keys
 * landed. A failure AT step 1 has changed nothing at all. ⛔ That costs two
 * extra writes when the tenant id is unchanged (a rotation of the secret alone)
 * and it is worth it: a half-configured tenant would register a button that
 * cannot complete a sign-in, which is worse than no button. Turning it off
 * loudly is the documented preference.
 *
 * ⛔ DISABLING WRITES THE TENANT FIRST TOO, for the same reason: the first write
 * of the three is already the one that takes the feature out of service.
 */
export function planEntraWrite(
  input: EntraInput,
  context: { storedSecret?: boolean } = {},
): EntraPlan {
  const { tenantId, clientId, clientSecret, blankedByTrim } = input
  const disabling = tenantId === '' && clientId === '' && clientSecret === ''

  if (disabling) {
    return {
      ok: true,
      disabling,
      configured: false,
      secretCleared: true,
      secretReplaced: false,
      writes: [
        { key: 'ENTRA_TENANT_ID', value: '' },
        { key: 'ENTRA_CLIENT_ID', value: '' },
        { key: 'ENTRA_CLIENT_SECRET', value: '' },
      ],
    }
  }

  // ⛔ THE REFUSAL AN ADMINISTRATOR DECOMMISSIONING A TENANT USED TO GET WAS
  // "The Directory (tenant) ID must be a GUID" — an instruction to put back the
  // value they had just deliberately removed, with no path to off except RDP
  // into the server. The form could never produce the one body that satisfies
  // `disabling`, so the disable branch and the panel's own cleared-status string
  // were both dead code. Blank ids with no explicit instruction about the secret
  // is now answered by naming the control that does the job.
  if (tenantId === '' && clientId === '' && clientSecret === undefined) {
    return {
      ok: false,
      status: 400,
      field: null,
      error:
        'Both IDs are blank. To switch Entra ID single sign-on off, use "Turn off single ' +
        'sign-on" — it clears the tenant, the application id and the stored secret together. ' +
        'Clearing the boxes alone cannot do it, because a blank secret box means "keep the ' +
        'secret you already have".',
    }
  }

  if (blankedByTrim) {
    return {
      ok: false,
      status: 400,
      field: ENTRA_FIELD_LABELS.ENTRA_CLIENT_SECRET,
      error:
        'The client secret was only whitespace. It has NOT been changed — if you meant to ' +
        'remove the stored secret, use "Turn off single sign-on", and if you meant to replace ' +
        'it, paste the secret value again.',
    }
  }

  // ⛔ WHICH FIELD IS WRONG IS NAMED, AND THE SUBMITTED VALUE IS NEVER ECHOED
  // BACK TO SAY SO. "Either the tenant or the client id is wrong" sends an
  // operator to check both boxes against a portal page; and the commonest way
  // to fail this check is to paste the CLIENT SECRET into an id box, so a
  // refusal that quoted its input would be a refusal that leaked a credential.
  if (!GUID.test(tenantId)) {
    return {
      ok: false,
      status: 400,
      field: ENTRA_FIELD_LABELS.ENTRA_TENANT_ID,
      error: `The Directory (tenant) ID must be a GUID, e.g. ${EXAMPLE_GUID}.`,
    }
  }
  if (!GUID.test(clientId)) {
    return {
      ok: false,
      status: 400,
      field: ENTRA_FIELD_LABELS.ENTRA_CLIENT_ID,
      error:
        'The Application (client) ID must be a GUID. Copy it from the app registration ' +
        'Overview page — not the Object ID, and not the secret ID.',
    }
  }
  // ⛔ AN INTERIOR LINE BREAK IS STILL REFUSED, AND REFUSED HERE RATHER THAN BY
  // setEnvValue. Trimming removes a trailing newline; it cannot remove one in
  // the middle, and `lib/envFile.ts` answers that with {ok:false}. Refusing
  // before the first write means the off-change-on sequence never STARTS, so
  // the feature is not taken down by a value that was never going to be
  // writable. ⛔ Note it would be refused TWICE over in NetVault — once per
  // target file — and the second refusal would land after the first file had
  // already been rewritten.
  if (clientSecret !== undefined && /[\r\n]/.test(clientSecret)) {
    return {
      ok: false,
      status: 400,
      field: ENTRA_FIELD_LABELS.ENTRA_CLIENT_SECRET,
      error:
        'The client secret contains a line break, so it cannot be stored in the environment ' +
        'file. Paste the secret value on one line.',
    }
  }

  const writes: EntraWrite[] = [{ key: 'ENTRA_TENANT_ID', value: '' }]
  // ⛔ ONLY A TYPED VALUE REPLACES THE STORED SECRET. No key in the body means
  // no write at all for that key — the stored secret is not read, not rewritten
  // and not touched.
  if (clientSecret !== undefined) {
    writes.push({ key: 'ENTRA_CLIENT_SECRET', value: clientSecret })
  }
  writes.push({ key: 'ENTRA_CLIENT_ID', value: clientId })
  writes.push({ key: 'ENTRA_TENANT_ID', value: tenantId })

  // Will the trio be complete once these land? ⛔ An explicitly CLEARED secret
  // leaves a tenant with no credential, which is a legitimate thing to ask for
  // and leaves SSO off — so it is REPORTED rather than refused or hidden.
  const secretAfter = clientSecret === undefined ? Boolean(context.storedSecret) : clientSecret !== ''

  return {
    ok: true,
    disabling: false,
    configured: Boolean(tenantId && clientId && secretAfter),
    secretCleared: clientSecret === '',
    secretReplaced: clientSecret !== undefined && clientSecret !== '',
    writes,
  }
}

/**
 * The shape `applyEntraWrites` needs back from a writer.
 *
 * ⛔ STRUCTURAL AND MINIMAL ON PURPOSE. `lib/envTargets.ts`'s `writeManagedKey`
 * satisfies it and carries far more — including a top-level `previous`, which
 * for `ENTRA_CLIENT_SECRET` is the OLD SECRET, and a nested per-file `previous`
 * inside `results`. Declaring only the four fields this module may read is what
 * stops the rest arriving by accident; `applyEntraWrites` then PICKS those four
 * and never spreads the result.
 *
 * ⛔ `unchanged` IS OPTIONAL AND AN ABSENT ONE COUNTS AS CHANGED.
 * `writeManagedKey` does not surface it at the top level (it writes two files
 * and they may disagree), so `changed` will over-report there. That is the safe
 * direction: `changed` only drives a message, and claiming a write happened
 * when it was a no-op is harmless, while claiming a no-op when something moved
 * would be a false all-clear.
 */
export type EntraWriteResult = {
  ok: boolean
  error?: string
  unchanged?: boolean
  backupPath?: string | null
}

export type EntraWriter = (key: EntraKey, value: string) => EntraWriteResult

export type EntraApplyOutcome =
  | { ok: true; landed: EntraKey[]; changed: EntraKey[] }
  | {
      ok: false
      failedKey: EntraKey
      error: string
      backupPath: string | null
      landed: EntraKey[]
      changed: EntraKey[]
    }

/**
 * An error describing a failed write may name the KEY. It may never carry the
 * VALUE.
 *
 * ⛔ THE REAL WRITER IS SAFE AND THIS STILL EARNS ITS PLACE. `lib/envFile.ts`
 * never interpolates a value into an error (it names the key, the line numbers
 * and the other keys it would have disturbed) — but the string being forwarded
 * here is not ours. It is whatever the injected writer returned, or whatever
 * `err.message` an unexpected throw carried, from code that may be changed by
 * someone who never read this file. One substitution makes the write-only
 * property hold for a hostile writer as well as a careful one.
 *
 * ⛔ IT REDACTS THE VALUE FOR EVERY KEY, NOT JUST THE SECRET, because the
 * commonest way to misconfigure this is to paste the client secret into an id
 * box — at which point the value being written as `ENTRA_TENANT_ID` IS the
 * secret.
 */
function withoutValue(message: string, value: string): string {
  if (!value) return message
  return message.split(value).join('[value redacted]')
}

/**
 * Run the planned writes, STOPPING AT THE FIRST REFUSAL.
 *
 * ⛔ THE RETURN VALUE IS CHECKED, AND IN SECVAULT IT WAS NOT. `setEnvValue`
 * RETURNS {ok:false, error}; it does not THROW for any of its real failure
 * modes — a duplicated key, the 1 MB size tripwire, an unreadable file, a line
 * break in the value, a failed backup, a failed write, a failed self-check.
 * SecVault's route wrapped three bare calls in a try/catch and inspected
 * nothing, so the catch could only fire on an exception the function is written
 * not to produce: EVERY refused write answered HTTP 200 `ok:true`, and the key
 * was reported as written when it had not been. Reproduced with a duplicated
 * `ENTRA_TENANT_ID` line: 200, three keys reported written, the tenant unchanged
 * on disk and the NEW SECRET sitting beside the OLD TENANT.
 *
 * ⛔ THE try/catch STAYS AS WELL, around the return-value check rather than
 * instead of it. The writer is not documented to throw, but it does real I/O,
 * and a defensive branch that turns an unexpected throw into the same
 * stop-and-report path costs nothing.
 *
 * ⛔ `write` IS INJECTED RATHER THAN REACHED FOR, which is what keeps this
 * module pure and lets a test drive every {ok:false} shape — including the ones
 * a real filesystem will not reproduce on demand — without a server or a
 * temporary file. The route passes
 * `(key, value) => writeManagedKey(key, value, { cwd })`. ⛔ This module must
 * not import `lib/envTargets.ts` itself: doing so would pull `node:fs`,
 * `node:child_process` and a `reg query` into the decision layer and the
 * partial-failure paths would stop being reachable from a test.
 */
export function applyEntraWrites(writes: EntraWrite[], write: EntraWriter): EntraApplyOutcome {
  const landed: EntraKey[] = []
  const changed: EntraKey[] = []
  for (const w of writes) {
    let result: EntraWriteResult
    try {
      result = write(w.key, w.value)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      result = { ok: false, error: `${w.key} could not be written: ${message}` }
    }
    if (!result || !result.ok) {
      return {
        ok: false,
        failedKey: w.key,
        error: withoutValue((result && result.error) || `${w.key} could not be written.`, w.value),
        backupPath: (result && result.backupPath) || null,
        landed,
        changed,
      }
    }
    // ⛔ REPORTED ONCE PER KEY, AND THE DEDUPE LIVES HERE BECAUSE THIS IS WHERE
    // THE DUPLICATE OCCURS. `ENTRA_TENANT_ID` is written TWICE by design
    // (blanked first, restored last), so a raw list names it twice and a
    // response built from one reads like a bug in the thing it is reporting.
    // SecVault deduped in its ROUTE — `[...new Set(outcome.landed)]` — which
    // left every future caller one `new Set` away from the same cosmetic bug;
    // doing it here means a caller cannot get it wrong. Order is preserved:
    // first occurrence wins.
    // ⛔ `changed` IS MEMBERSHIP-CHECKED SEPARATELY FROM `landed`, not derived
    // from it. On a first-ever configure the tenant is ALREADY blank, so write
    // 1 is a no-op and write 4 is the real change — keyed off `landed` the
    // change would be swallowed and the panel would report that nothing moved.
    if (!landed.includes(w.key)) landed.push(w.key)
    if (result.unchanged !== true && !changed.includes(w.key)) changed.push(w.key)
  }
  return { ok: true, landed, changed }
}

export type EntraFailureAnswer = {
  error: string
  failedField: string | null
  written: EntraKey[]
  writtenFields: string[]
  nothingChanged: boolean
  ssoDisabled: boolean
  backupPath: string | null
}

/**
 * What to tell the administrator when a write in the middle of the sequence
 * failed — including WHICH keys landed, because they are the person who has to
 * recover from it.
 *
 * ⛔ THE PARTIAL STATE IS THE POINT. SecVault's old 500 carried the written list
 * in the body while the panel rendered `error` alone, so even a genuine failure
 * did not say which keys had changed.
 *
 * ⛔ "NOTHING LANDED" AND "SINGLE SIGN-ON IS NOW OFF" ARE THE ONLY TWO STATES A
 * STOPPED SEQUENCE CAN BE IN, and that is a PROPERTY of `planEntraWrite`'s order
 * rather than a guess about it: the tenant blank is always the first write, so
 * the moment anything has landed, the feature is off.
 *
 * ⛔ IT CARRIES NO VALUE, ONLY LABELS — see this file's header on `previous`.
 */
export function entraWriteFailureAnswer(
  outcome: Extract<EntraApplyOutcome, { ok: false }>,
): EntraFailureAnswer {
  // ⛔ ALREADY DEDUPED BY applyEntraWrites, AND NOT DEDUPED AGAIN HERE. A
  // second `new Set` would be a guard that cannot fire — a stopped sequence can
  // never contain the tenant twice, because the restoring write is the LAST one
  // and nothing follows it — and unreachable defensive code is indistinguishable
  // from a guard that works until the day it is needed. Mutation-verified: with
  // the dedupe duplicated here, breaking it failed no test at all.
  const landed = outcome.landed || []
  const nothingChanged = landed.length === 0
  const parts = [`Entra ID single sign-on could not be saved: ${outcome.error}`]
  if (nothingChanged) {
    parts.push('Nothing was changed — the previous configuration is intact.')
  } else {
    parts.push(
      'Single sign-on is now OFF: the tenant id was cleared first on purpose, so a part-finished ' +
        'change can never leave a credential beside an id it does not belong to. Local accounts ' +
        'are unaffected. Fix the problem above and save again to switch it back on.',
    )
    parts.push(`Already written: ${landed.map((k) => ENTRA_FIELD_LABELS[k] || k).join(', ')}.`)
  }
  if (outcome.backupPath) parts.push(`The previous file is at ${outcome.backupPath}.`)
  return {
    error: parts.join(' '),
    failedField: ENTRA_FIELD_LABELS[outcome.failedKey] || outcome.failedKey || null,
    written: landed,
    writtenFields: landed.map((k) => ENTRA_FIELD_LABELS[k] || k),
    nothingChanged,
    ssoDisabled: !nothingChanged,
    backupPath: outcome.backupPath || null,
  }
}

export type EntraRestartPending = { pending: boolean; fields: string[] }

/**
 * Which fields differ between what is SAVED on disk and what the process is
 * actually RUNNING with — i.e. whether a restart is still owed.
 *
 * ⛔ A RESTART IS ALWAYS REQUIRED AND IT IS NOT OPTIONAL MACHINERY. NextAuth
 * builds its provider array ONCE, at module load, from `process.env`. A tenant
 * stored in a database would not be available at that moment, so the provider
 * could not be registered at all — which is why these three live in an env file
 * rather than in `app_settings`, and why a saved value is not a running value.
 *
 * ⛔ IT COMPARES VALUES, AND SECVAULT USED TO COMPARE CONFIGURED-NESS. The panel
 * computed `savedConfigured !== runningConfigured` — boolean against boolean —
 * and both are `true` whenever Entra is already live, so ANY EDIT to an
 * already-configured tenant produced `pending === false`. The routine case it
 * broke is a client-secret ROTATION: the administrator pastes the new secret,
 * saves, refreshes, sees no banner, and believes the new credential is in force
 * while the running process still presents the REVOKED one to Microsoft and
 * every Entra sign-in fails with nothing on screen saying why. It worked only
 * for the first-ever configure, which is why it passed manual testing.
 *
 * ⛔ THE SECRETS ARE COMPARED HERE, ON THE SERVER, AND NEITHER LEAVES IT. Only
 * the field LABEL of a difference is returned.
 */
export function entraRestartPending(
  saved: Record<string, string | undefined> | null | undefined,
  running: Record<string, string | undefined> | null | undefined,
): EntraRestartPending {
  const norm = (v: string | undefined) => String(v == null ? '' : v).trim()
  const fields: string[] = []
  for (const key of ENTRA_KEYS) {
    if (norm(saved ? saved[key] : undefined) !== norm(running ? running[key] : undefined)) {
      fields.push(ENTRA_FIELD_LABELS[key])
    }
  }
  return { pending: fields.length > 0, fields }
}

// The Redirect URI classifier used to live here and now lives in
// lib/redirectUri.ts. It has to be importable by a 'use client' component, and
// this module reaches node:fs through envFile.ts — which would drag the whole
// Node fs shim into the browser bundle, exactly as importing lib/directoryRefusals.ts
// dragged in the pg driver. A pure function with no imports is the only kind a
// client component can share with a route.
