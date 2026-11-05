import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENTRA_KEYS,
  ENTRA_FIELD_LABELS,
  GUID,
  normaliseEntraInput,
  isEntraConfigured,
  duplicateEntraKeys,
  planEntraWrite,
  applyEntraWrites,
  entraWriteFailureAnswer,
  entraRestartPending,
  type EntraKey,
  type EntraPlan,
  type EntraWrite,
  type EntraWriteResult,
  type EntraWriter,
} from '../lib/entraSettings.ts'

// ⛔ EVERY IDENTIFIER HERE IS FAKE. No real tenant, application, secret,
// hostname or address appears in this file — the GUIDs are obviously-patterned
// and the secret is a sentinel whose only job is to be searched for.
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const CLIENT = '11112222-3333-4444-5555-666677778888'
const OLD_TENANT = '99999999-8888-7777-6666-555555555555'
const OLD_CLIENT = 'dddddddd-cccc-bbbb-aaaa-999999999999'

/**
 * The sentinel. It is deliberately unmistakable: a substring search for it in a
 * serialised result is then a search for "did the secret travel", with no
 * chance of a coincidental match.
 */
const SENTINEL = 'SENTINEL-client-secret-must-never-travel-7fQ2'
const OLD_SENTINEL = 'SENTINEL-old-client-secret-also-must-not-travel-3xZ9'

type FakeEnv = Record<string, string>

/** A live, working configuration — the state every dangerous path starts from. */
function liveEnv(): FakeEnv {
  return {
    ENTRA_TENANT_ID: OLD_TENANT,
    ENTRA_CLIENT_ID: OLD_CLIENT,
    ENTRA_CLIENT_SECRET: OLD_SENTINEL,
    // A neighbour, to prove nothing else is touched.
    NEXTAUTH_URL: 'https://netvault.example.com:3000',
  }
}

type WriterOpts = {
  env?: FakeEnv
  /** 1-based index of the call that fails. */
  failAt?: number
  /** 1-based index of the call that THROWS instead of returning. */
  throwAt?: number
  /** The error string the failing call returns. */
  error?: string
  /** Echo the value being written into the error — a hostile/careless writer. */
  echoValueInError?: boolean
  /** Return the writer's own `previous` the way writeManagedKey really does. */
  reportPrevious?: boolean
  unchangedKeys?: EntraKey[]
}

/**
 * A writer that mutates a fake env map, so a test asserts the STATE a partial
 * failure leaves behind rather than only the report about it.
 */
function makeWriter(opts: WriterOpts = {}) {
  const env: FakeEnv = opts.env ?? {}
  const calls: Array<{ key: EntraKey; value: string }> = []
  const write: EntraWriter = (key, value) => {
    const n = calls.length + 1
    calls.push({ key, value })
    if (opts.throwAt === n) throw new Error(`EBUSY writing ${key}`)
    if (opts.failAt === n) {
      const base = opts.error ?? `${key} appears more than once in .env — remove the duplicates.`
      return {
        ok: false,
        error: opts.echoValueInError ? `${base} (tried to write "${value}")` : base,
        backupPath: '/tmp/fake/.env.bak',
        ...(opts.reportPrevious ? { previous: env[key] ?? null } : {}),
      } as EntraWriteResult
    }
    const previous = env[key] ?? null
    const unchanged = (opts.unchangedKeys ?? []).includes(key) || previous === value
    env[key] = value
    return {
      ok: true,
      unchanged,
      backupPath: null,
      ...(opts.reportPrevious ? { previous } : {}),
    } as EntraWriteResult
  }
  return { write, calls, env }
}

/**
 * The plan for a straightforward "configure all three" save. `null` means the
 * body carries NO clientSecret key at all — which is not the same as `''`, and
 * must not be spelled `undefined` here, because a default parameter would
 * swallow it and quietly test the wrong path.
 */
function fullPlan(secret: string | null = SENTINEL): Extract<EntraPlan, { ok: true }> {
  const plan = planEntraWrite(
    normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT, ...(secret === null ? {} : { clientSecret: secret }) }),
    { storedSecret: true },
  )
  assert.equal(plan.ok, true)
  return plan as Extract<EntraPlan, { ok: true }>
}

const seq = (writes: EntraWrite[]) => writes.map((w) => w.key)

// ── normalisation: the three-way secret ─────────────────────────────────────

test('an absent clientSecret means LEAVE IT ALONE; a blank string means CLEAR IT', () => {
  // No key at all — the common case, because the field is write-only and so a
  // form can never pre-fill it.
  const absent = normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT })
  assert.equal(absent.clientSecret, undefined)

  // An explicit empty string is the deliberate instruction to remove it.
  const cleared = normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT, clientSecret: '' })
  assert.equal(cleared.clientSecret, '')

  // A typed value replaces it, and surrounding whitespace is trimmed because
  // parseEnv trims on read — the untrimmed form was never readable back.
  const typed = normaliseEntraInput({ tenantId: ` ${TENANT} `, clientId: CLIENT, clientSecret: `  ${SENTINEL}\n` })
  assert.equal(typed.clientSecret, SENTINEL)
  assert.equal(typed.tenantId, TENANT)
  assert.equal(typed.blankedByTrim, false)
})

test('a wholly-whitespace secret is flagged, never read as a clear', () => {
  const ws = normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT, clientSecret: '   \t  ' })
  assert.equal(ws.clientSecret, '')
  assert.equal(ws.blankedByTrim, true, 'it trimmed to blank from a non-blank paste')

  // And the plan refuses it rather than deleting a working credential.
  const plan = planEntraWrite(ws, { storedSecret: true })
  assert.equal(plan.ok, false)
  assert.match((plan as { error: string }).error, /only whitespace/i)
  assert.match((plan as { error: string }).error, /NOT been changed/)
  assert.equal((plan as { field: string | null }).field, ENTRA_FIELD_LABELS.ENTRA_CLIENT_SECRET)
})

test('a non-object body and non-string fields normalise to blank rather than throwing', () => {
  for (const body of [null, undefined, 'nope', 42, [], { tenantId: 12, clientId: {}, clientSecret: 7 }]) {
    const input = normaliseEntraInput(body)
    assert.equal(input.tenantId, '')
    assert.equal(input.clientId, '')
    assert.equal(input.clientSecret, undefined, 'a non-string secret is NOT a clear instruction')
    assert.equal(input.blankedByTrim, false)
  }
})

// ── all three are required together, in both directions ─────────────────────

test('all three values are required together — any ONE blank is not configured', () => {
  const complete = { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SENTINEL }
  assert.equal(isEntraConfigured(complete), true)

  // Each key blanked in turn: three separate half-configurations, none of which
  // may register a sign-in button.
  for (const key of ENTRA_KEYS) {
    assert.equal(isEntraConfigured({ ...complete, [key]: '' }), false, `${key} blank`)
    assert.equal(isEntraConfigured({ ...complete, [key]: '   ' }), false, `${key} whitespace`)
    const absent: Record<string, string> = { ...complete }
    delete absent[key]
    assert.equal(isEntraConfigured(absent), false, `${key} absent`)
  }

  // The normal state of an install that does not use Entra.
  assert.equal(isEntraConfigured({}), false)
  assert.equal(isEntraConfigured(null), false)
})

test('a plan reports configured only when all three will be present afterwards', () => {
  // Secret supplied: configured.
  assert.equal(fullPlan(SENTINEL).configured, true)

  // Secret left alone, one already stored: still configured.
  const keep = planEntraWrite(normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT }), { storedSecret: true })
  assert.equal((keep as { configured: boolean }).configured, true)

  // Secret left alone and NONE stored: ids save, SSO stays off. Reported, not
  // refused and not hidden.
  const none = planEntraWrite(normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT }), { storedSecret: false })
  assert.equal((none as { ok: boolean }).ok, true)
  assert.equal((none as { configured: boolean }).configured, false)

  // Secret explicitly CLEARED: a legitimate request that leaves SSO off.
  const cleared = planEntraWrite(
    normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT, clientSecret: '' }),
    { storedSecret: true },
  )
  assert.equal((cleared as { ok: boolean }).ok, true)
  assert.equal((cleared as { configured: boolean }).configured, false)
  assert.equal((cleared as { secretCleared: boolean }).secretCleared, true)
  assert.equal((cleared as { secretReplaced: boolean }).secretReplaced, false)
})

// ── THE WRITE ORDER ─────────────────────────────────────────────────────────

test('THE WRITE ORDER IS OFF then CHANGE then ON — the exact sequence, with values', () => {
  const plan = fullPlan(SENTINEL)

  // The sequence itself, asserted as a sequence. Not "all four happened".
  assert.deepEqual(plan.writes, [
    { key: 'ENTRA_TENANT_ID', value: '' },
    { key: 'ENTRA_CLIENT_SECRET', value: SENTINEL },
    { key: 'ENTRA_CLIENT_ID', value: CLIENT },
    { key: 'ENTRA_TENANT_ID', value: TENANT },
  ])

  // Said again as the property, so the reason survives a refactor: the FIRST
  // write takes the feature out of service and the LAST puts it back.
  assert.equal(plan.writes[0].key, 'ENTRA_TENANT_ID')
  assert.equal(plan.writes[0].value, '', 'the first write must BLANK the tenant')
  assert.equal(plan.writes[plan.writes.length - 1].key, 'ENTRA_TENANT_ID')
  assert.equal(plan.writes[plan.writes.length - 1].value, TENANT, 'the tenant goes back LAST')
  assert.ok(
    plan.writes.findIndex((w) => w.key === 'ENTRA_CLIENT_SECRET') >
      plan.writes.findIndex((w) => w.key === 'ENTRA_TENANT_ID' && w.value === ''),
    'the secret is written AFTER the tenant is blanked, never before it',
  )

  // And the writer really is driven in that order.
  const w = makeWriter({ env: liveEnv() })
  const outcome = applyEntraWrites(plan.writes, w.write)
  assert.equal(outcome.ok, true)
  assert.deepEqual(w.calls.map((c) => c.key), [
    'ENTRA_TENANT_ID',
    'ENTRA_CLIENT_SECRET',
    'ENTRA_CLIENT_ID',
    'ENTRA_TENANT_ID',
  ])
  assert.equal(w.calls[0].value, '')
  assert.equal(w.env.ENTRA_TENANT_ID, TENANT)
  assert.equal(w.env.NEXTAUTH_URL, 'https://netvault.example.com:3000', 'nothing else is touched')
})

test('the tenant is blanked first even when ONLY the secret is rotating', () => {
  // Same tenant and client id as the stored ones — a pure secret rotation. It
  // still pays two extra writes to take the feature out of service first.
  const plan = planEntraWrite(
    normaliseEntraInput({ tenantId: OLD_TENANT, clientId: OLD_CLIENT, clientSecret: SENTINEL }),
    { storedSecret: true },
  ) as Extract<EntraPlan, { ok: true }>
  assert.equal(plan.ok, true)
  assert.deepEqual(seq(plan.writes), [
    'ENTRA_TENANT_ID',
    'ENTRA_CLIENT_SECRET',
    'ENTRA_CLIENT_ID',
    'ENTRA_TENANT_ID',
  ])
  assert.equal(plan.writes[0].value, '')
})

test('a plan with no secret supplied omits the secret write entirely, keeping the order', () => {
  const plan = fullPlan(null)
  assert.deepEqual(plan.writes, [
    { key: 'ENTRA_TENANT_ID', value: '' },
    { key: 'ENTRA_CLIENT_ID', value: CLIENT },
    { key: 'ENTRA_TENANT_ID', value: TENANT },
  ])
})

test('disabling clears all three and blanks the tenant FIRST', () => {
  const plan = planEntraWrite(
    normaliseEntraInput({ tenantId: '', clientId: '', clientSecret: '' }),
    { storedSecret: true },
  ) as Extract<EntraPlan, { ok: true }>
  assert.equal(plan.ok, true)
  assert.equal(plan.disabling, true)
  assert.equal(plan.configured, false)
  assert.deepEqual(plan.writes, [
    { key: 'ENTRA_TENANT_ID', value: '' },
    { key: 'ENTRA_CLIENT_ID', value: '' },
    { key: 'ENTRA_CLIENT_SECRET', value: '' },
  ])

  const w = makeWriter({ env: liveEnv() })
  assert.equal(applyEntraWrites(plan.writes, w.write).ok, true)
  assert.equal(w.calls[0].key, 'ENTRA_TENANT_ID')
  assert.equal(isEntraConfigured(w.env), false)
  assert.deepEqual(
    ENTRA_KEYS.map((k) => w.env[k]),
    ['', '', ''],
    'turning SSO off clears all three, not some of them',
  )
})

// ── a failure at each step of that sequence, and the state it leaves ────────

test('a failure at the FIRST write changes nothing at all', () => {
  const before = liveEnv()
  const w = makeWriter({ env: { ...before }, failAt: 1 })
  const outcome = applyEntraWrites(fullPlan().writes, w.write)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.failedKey, 'ENTRA_TENANT_ID')
  assert.deepEqual(outcome.landed, [], 'nothing landed')
  assert.deepEqual(w.env, before, 'the file is byte-for-byte as it was')
  assert.equal(isEntraConfigured(w.env), true, 'the previous working configuration is intact')
  assert.equal(w.calls.length, 1, 'the sequence stops at the first refusal')

  const answer = entraWriteFailureAnswer(outcome as Extract<typeof outcome, { ok: false }>)
  assert.equal(answer.nothingChanged, true)
  assert.equal(answer.ssoDisabled, false)
  assert.deepEqual(answer.written, [])
  assert.match(answer.error, /Nothing was changed/)
})

test('a failure at the SECRET write leaves Entra OFF — never a new secret beside the old tenant', () => {
  const w = makeWriter({ env: liveEnv(), failAt: 2 })
  const outcome = applyEntraWrites(fullPlan().writes, w.write)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.failedKey, 'ENTRA_CLIENT_SECRET')
  assert.deepEqual(outcome.landed, ['ENTRA_TENANT_ID'])
  // The state that matters: the tenant is blank, so no provider is registered.
  assert.equal(w.env.ENTRA_TENANT_ID, '')
  assert.equal(isEntraConfigured(w.env), false)
  // And the stored secret was not replaced, so nothing new sits beside an old id.
  assert.equal(w.env.ENTRA_CLIENT_SECRET, OLD_SENTINEL)
  assert.equal(w.calls.length, 2)

  const answer = entraWriteFailureAnswer(outcome as Extract<typeof outcome, { ok: false }>)
  assert.equal(answer.ssoDisabled, true)
  assert.equal(answer.nothingChanged, false)
  assert.equal(answer.failedField, ENTRA_FIELD_LABELS.ENTRA_CLIENT_SECRET)
  assert.match(answer.error, /Single sign-on is now OFF/)
  assert.match(answer.error, /Local accounts are unaffected/)
})

test('a failure at the CLIENT ID write leaves Entra OFF', () => {
  const w = makeWriter({ env: liveEnv(), failAt: 3 })
  const outcome = applyEntraWrites(fullPlan().writes, w.write)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.failedKey, 'ENTRA_CLIENT_ID')
  assert.deepEqual(outcome.landed, ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_SECRET'])
  assert.equal(w.env.ENTRA_TENANT_ID, '')
  assert.equal(isEntraConfigured(w.env), false)
  // The NEW secret landed beside the OLD client id — harmless precisely because
  // the tenant is blank, which is the property the order exists to guarantee.
  assert.equal(w.env.ENTRA_CLIENT_SECRET, SENTINEL)
  assert.equal(w.env.ENTRA_CLIENT_ID, OLD_CLIENT)

  const answer = entraWriteFailureAnswer(outcome as Extract<typeof outcome, { ok: false }>)
  assert.equal(answer.ssoDisabled, true)
  assert.deepEqual(answer.writtenFields, [
    ENTRA_FIELD_LABELS.ENTRA_TENANT_ID,
    ENTRA_FIELD_LABELS.ENTRA_CLIENT_SECRET,
  ])
})

test('a failure at the FINAL tenant write leaves Entra OFF, and the report names it once', () => {
  const w = makeWriter({ env: liveEnv(), failAt: 4 })
  const outcome = applyEntraWrites(fullPlan().writes, w.write)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.failedKey, 'ENTRA_TENANT_ID')
  assert.equal(w.env.ENTRA_TENANT_ID, '', 'the feature stays off — the restore never landed')
  assert.equal(isEntraConfigured(w.env), false)

  const answer = entraWriteFailureAnswer(outcome as Extract<typeof outcome, { ok: false }>)
  assert.equal(answer.ssoDisabled, true)
  // ENTRA_TENANT_ID is written TWICE by design; the report must not say so twice.
  assert.deepEqual(answer.written, ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_CLIENT_ID'])
  assert.equal(
    answer.error.match(new RegExp(ENTRA_FIELD_LABELS.ENTRA_TENANT_ID.replace(/[()]/g, '\\$&'), 'g'))?.length,
    1,
    'the tenant label appears once in the report, not twice',
  )
  assert.equal(answer.backupPath, '/tmp/fake/.env.bak')
})

test('every step of the sequence is covered, and any landed write means SSO is off', () => {
  // The invariant, asserted across the whole sequence rather than per-step: for
  // EVERY failure point, either nothing changed or Entra is off. There is no
  // third state, and that is a property of the write order.
  for (let failAt = 1; failAt <= 4; failAt++) {
    const w = makeWriter({ env: liveEnv(), failAt })
    const outcome = applyEntraWrites(fullPlan().writes, w.write)
    assert.equal(outcome.ok, false, `failAt=${failAt}`)
    const answer = entraWriteFailureAnswer(outcome as Extract<typeof outcome, { ok: false }>)
    if (answer.nothingChanged) {
      assert.equal(isEntraConfigured(w.env), true, `failAt=${failAt}: intact`)
    } else {
      assert.equal(w.env.ENTRA_TENANT_ID, '', `failAt=${failAt}: tenant must be blank`)
      assert.equal(isEntraConfigured(w.env), false, `failAt=${failAt}: SSO must be off`)
    }
  }
})

test('a writer that THROWS is treated as a refusal, not an exception', () => {
  const w = makeWriter({ env: liveEnv(), throwAt: 2 })
  let outcome: ReturnType<typeof applyEntraWrites>
  assert.doesNotThrow(() => {
    outcome = applyEntraWrites(fullPlan().writes, w.write)
  })
  outcome = outcome!
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.failedKey, 'ENTRA_CLIENT_SECRET')
  assert.match((outcome as { error: string }).error, /EBUSY/)
  assert.equal(w.env.ENTRA_TENANT_ID, '', 'the stop-and-report path leaves SSO off, as a refusal does')
})

test('a writer answering {ok:false} is never read as success', () => {
  // The SecVault defect this exists to prevent: three bare calls in a try/catch
  // that inspected nothing, so every refused write answered 200 ok:true.
  const w = makeWriter({ env: liveEnv(), failAt: 1, error: 'ENTRA_TENANT_ID appears 2 times' })
  const outcome = applyEntraWrites(fullPlan().writes, w.write)
  assert.equal(outcome.ok, false)
  assert.deepEqual(outcome.landed, [], 'a refused key is NOT reported as written')
})

test('the tenant id is REPORTED ONCE although it is written twice', () => {
  const w = makeWriter({ env: liveEnv() })
  const outcome = applyEntraWrites(fullPlan().writes, w.write)
  assert.equal(outcome.ok, true)
  // The writer really was called four times — the duplication is by design.
  assert.equal(w.calls.length, 4)
  assert.equal(w.calls.filter((c) => c.key === 'ENTRA_TENANT_ID').length, 2)
  // And the report names each key once, in first-occurrence order, so a caller
  // cannot build a response that lists the tenant twice.
  assert.deepEqual(outcome.landed, ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_CLIENT_ID'])
  assert.deepEqual(outcome.ok && outcome.changed, [
    'ENTRA_TENANT_ID',
    'ENTRA_CLIENT_SECRET',
    'ENTRA_CLIENT_ID',
  ])
})

test('a key that is a NO-OP first and a real change later is still reported as changed', () => {
  // The first-ever configure: the tenant is already blank, so write 1 is a
  // no-op and write 4 is the real change. Keyed off `landed`, that change would
  // be swallowed and the panel would report that nothing moved.
  const w = makeWriter({ env: { ENTRA_TENANT_ID: '', ENTRA_CLIENT_ID: '', ENTRA_CLIENT_SECRET: '' } })
  const outcome = applyEntraWrites(fullPlan().writes, w.write)
  assert.equal(outcome.ok, true)
  assert.ok(outcome.ok && outcome.changed.includes('ENTRA_TENANT_ID'), 'the restore is a change')
  assert.equal(w.calls[0].value, '')
  assert.equal(w.env.ENTRA_TENANT_ID, TENANT)
  assert.equal(isEntraConfigured(w.env), true)
})

test('unchanged writes land but are not reported as changed', () => {
  const w = makeWriter({ env: liveEnv(), unchangedKeys: ['ENTRA_CLIENT_ID'] })
  const outcome = applyEntraWrites(fullPlan().writes, w.write)
  assert.equal(outcome.ok, true)
  assert.ok(outcome.landed.includes('ENTRA_CLIENT_ID'))
  assert.ok(!(outcome.ok && outcome.changed.includes('ENTRA_CLIENT_ID')))
  // A writer that does not report `unchanged` at all counts as changed — the
  // safe direction, since a false no-op claim would be a false all-clear.
  const w2 = makeWriter({ env: liveEnv() })
  const o2 = applyEntraWrites([{ key: 'ENTRA_CLIENT_ID', value: CLIENT }], (k, v) => {
    w2.write(k, v)
    return { ok: true }
  })
  assert.deepEqual(o2.ok && o2.changed, ['ENTRA_CLIENT_ID'])
})

// ── a blank secret keeps the stored one ─────────────────────────────────────

test('a BLANK SECRET BOX keeps the stored secret — nothing is written for it', () => {
  // The body carries no clientSecret key at all, which is what a write-only
  // field submits when the operator did not retype it.
  const plan = fullPlan(null)
  assert.ok(
    !plan.writes.some((w) => w.key === 'ENTRA_CLIENT_SECRET'),
    'no write is planned for the secret, so it cannot be overwritten',
  )

  const w = makeWriter({ env: liveEnv() })
  const outcome = applyEntraWrites(plan.writes, w.write)
  assert.equal(outcome.ok, true)
  assert.equal(w.env.ENTRA_CLIENT_SECRET, OLD_SENTINEL, 'the stored secret survives untouched')
  assert.equal(isEntraConfigured(w.env), true, 'and Entra is still configured afterwards')
  assert.ok(!w.calls.some((c) => c.key === 'ENTRA_CLIENT_SECRET'))
})

test('a blank secret and an EXPLICITLY CLEARED one are different instructions', () => {
  const keep = planEntraWrite(normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT }), { storedSecret: true })
  const clear = planEntraWrite(
    normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT, clientSecret: '' }),
    { storedSecret: true },
  )
  const keepW = makeWriter({ env: liveEnv() })
  const clearW = makeWriter({ env: liveEnv() })
  applyEntraWrites((keep as Extract<EntraPlan, { ok: true }>).writes, keepW.write)
  applyEntraWrites((clear as Extract<EntraPlan, { ok: true }>).writes, clearW.write)

  assert.equal(keepW.env.ENTRA_CLIENT_SECRET, OLD_SENTINEL, 'blank keeps')
  assert.equal(clearW.env.ENTRA_CLIENT_SECRET, '', 'an explicit empty string clears')
})

// ── duplicate keys ──────────────────────────────────────────────────────────

test('a DUPLICATED key is detected before anything is planned', () => {
  const text = [
    '# NetVault environment',
    'NEXTAUTH_URL=https://netvault.example.com:3000',
    `ENTRA_TENANT_ID=${OLD_TENANT}`,
    `ENTRA_CLIENT_ID=${OLD_CLIENT}`,
    '',
    '# pasted in by hand later, following the setup notes',
    `ENTRA_TENANT_ID=${TENANT}`,
  ].join('\n')
  assert.deepEqual(duplicateEntraKeys(text), ['ENTRA_TENANT_ID'])

  // All three duplicated — what following both .env.example and a setup doc does.
  const all = ENTRA_KEYS.map((k) => `${k}=\n${k}=x`).join('\n')
  assert.deepEqual(duplicateEntraKeys(all), [
    'ENTRA_TENANT_ID',
    'ENTRA_CLIENT_ID',
    'ENTRA_CLIENT_SECRET',
  ])

  // A clean file, an empty file and a nullish one all report no duplicates.
  assert.deepEqual(duplicateEntraKeys(`ENTRA_TENANT_ID=${TENANT}\nENTRA_CLIENT_ID=${CLIENT}\n`), [])
  assert.deepEqual(duplicateEntraKeys(''), [])
  assert.deepEqual(duplicateEntraKeys(null), [])
  assert.deepEqual(duplicateEntraKeys(undefined), [])
})

test('the duplicate scan honours the env grammar LINE_RE defines, not a second one', () => {
  // CRLF: the shipped shape on Windows, where the installer writes these files.
  assert.deepEqual(
    duplicateEntraKeys(`ENTRA_TENANT_ID=${OLD_TENANT}\r\nENTRA_TENANT_ID=${TENANT}\r\n`),
    ['ENTRA_TENANT_ID'],
  )
  // `export ` is tolerated, because operators paste from shell scripts.
  assert.deepEqual(
    duplicateEntraKeys(`export ENTRA_CLIENT_ID=${OLD_CLIENT}\nENTRA_CLIENT_ID=${CLIENT}\n`),
    ['ENTRA_CLIENT_ID'],
  )
  // Leading whitespace is part of the same grammar.
  assert.deepEqual(duplicateEntraKeys('  ENTRA_CLIENT_ID=a\nENTRA_CLIENT_ID=b'), ['ENTRA_CLIENT_ID'])
  // A commented-out line is not an occurrence — a file carrying the example
  // block plus one real line is NOT a duplicate, and refusing it would block a
  // save on every stock .env.
  assert.deepEqual(duplicateEntraKeys(`#ENTRA_TENANT_ID=\nENTRA_TENANT_ID=${TENANT}`), [])
  assert.deepEqual(duplicateEntraKeys(`# ENTRA_TENANT_ID=${OLD_TENANT}\nENTRA_TENANT_ID=${TENANT}`), [])
  // A key that merely CONTAINS one of ours is a different key.
  assert.deepEqual(duplicateEntraKeys('MY_ENTRA_TENANT_ID=a\nMY_ENTRA_TENANT_ID=b'), [])
  // And a narrowed scan only answers about the keys it was asked about.
  assert.deepEqual(duplicateEntraKeys('ENTRA_CLIENT_ID=a\nENTRA_CLIENT_ID=b', ['ENTRA_TENANT_ID']), [])
})

// ── GUID validation, per field ──────────────────────────────────────────────

test('the Directory (tenant) ID must be a GUID, and the refusal says which field', () => {
  for (const bad of ['not-a-guid', '1234', `${TENANT}x`, TENANT.slice(0, -1), `{${TENANT}}`, 'tenant.example.com']) {
    const plan = planEntraWrite(normaliseEntraInput({ tenantId: bad, clientId: CLIENT, clientSecret: SENTINEL }))
    assert.equal(plan.ok, false, bad)
    const refusal = plan as Extract<EntraPlan, { ok: false }>
    assert.equal(refusal.status, 400)
    assert.match(refusal.error, /Directory \(tenant\) ID must be a GUID/)
    assert.equal(refusal.field, ENTRA_FIELD_LABELS.ENTRA_TENANT_ID)
    assert.ok(!refusal.error.includes(bad), 'the submitted value is never echoed back')
  }
  // Mixed case and surrounding whitespace are fine — Entra prints GUIDs either way.
  const ok = planEntraWrite(
    normaliseEntraInput({ tenantId: ` ${TENANT.toUpperCase()} `, clientId: CLIENT, clientSecret: SENTINEL }),
  )
  assert.equal(ok.ok, true)
  assert.equal(GUID.test(TENANT.toUpperCase()), true)
})

test('the Application (client) ID must be a GUID, and the refusal says which field', () => {
  for (const bad of ['not-a-guid', 'my-app', `${CLIENT}-extra`, '']) {
    const plan = planEntraWrite(normaliseEntraInput({ tenantId: TENANT, clientId: bad, clientSecret: SENTINEL }))
    assert.equal(plan.ok, false, bad)
    const refusal = plan as Extract<EntraPlan, { ok: false }>
    assert.equal(refusal.status, 400)
    assert.match(refusal.error, /Application \(client\) ID must be a GUID/)
    assert.equal(refusal.field, ENTRA_FIELD_LABELS.ENTRA_CLIENT_ID)
    assert.match(refusal.error, /not the Object ID/, 'it names the two values people copy instead')
  }
})

test('the two id refusals are distinguishable — a wrong tenant is not reported as a wrong client', () => {
  const tenantBad = planEntraWrite(normaliseEntraInput({ tenantId: 'x', clientId: CLIENT, clientSecret: SENTINEL }))
  const clientBad = planEntraWrite(normaliseEntraInput({ tenantId: TENANT, clientId: 'x', clientSecret: SENTINEL }))
  assert.notEqual((tenantBad as { error: string }).error, (clientBad as { error: string }).error)
  assert.notEqual((tenantBad as { field: string }).field, (clientBad as { field: string }).field)
})

test('an interior line break in the secret is refused BEFORE the sequence starts', () => {
  for (const bad of [`${SENTINEL}\nmore`, `${SENTINEL}\r\nmore`, `a\rb`]) {
    const plan = planEntraWrite(normaliseEntraInput({ tenantId: TENANT, clientId: CLIENT, clientSecret: bad }))
    assert.equal(plan.ok, false)
    const refusal = plan as Extract<EntraPlan, { ok: false }>
    assert.match(refusal.error, /line break/)
    assert.equal(refusal.field, ENTRA_FIELD_LABELS.ENTRA_CLIENT_SECRET)
    assert.ok(!('writes' in refusal), 'no write is planned, so the feature is never taken down')
  }
})

test('blank ids with no secret instruction names the control that disables SSO', () => {
  // Clearing the boxes is a HALF-configuration, not a disable — and the refusal
  // must not be "the tenant must be a GUID", which told a decommissioning
  // administrator to put back the value they had just removed.
  const plan = planEntraWrite(normaliseEntraInput({ tenantId: '', clientId: '' }), { storedSecret: true })
  assert.equal(plan.ok, false)
  const refusal = plan as Extract<EntraPlan, { ok: false }>
  assert.equal(refusal.status, 400)
  assert.ok(!/must be a GUID/.test(refusal.error), 'it must not demand the value they just removed')
  assert.match(refusal.error, /Turn off single sign-on/)
  assert.match(refusal.error, /blank secret box means "keep the secret you already have"/)
})

test('a half-configuration is refused rather than inferred as a disable', () => {
  // One id blank, the other filled: not a disable, and not a valid configure.
  for (const body of [
    { tenantId: TENANT, clientId: '' },
    { tenantId: '', clientId: CLIENT },
    { tenantId: TENANT, clientId: '', clientSecret: '' },
    { tenantId: '', clientId: CLIENT, clientSecret: SENTINEL },
  ]) {
    const plan = planEntraWrite(normaliseEntraInput(body), { storedSecret: true })
    assert.equal(plan.ok, false, JSON.stringify(Object.keys(body)))
    assert.equal((plan as Extract<EntraPlan, { ok: false }>).status, 400)
  }
})

// ── restart pending ─────────────────────────────────────────────────────────

test('restart-pending compares VALUES, so a SECRET ROTATION is detected', () => {
  // The case the configured-NESS comparison got wrong: all three set on both
  // sides, only the secret different. A boolean comparison reported no restart
  // owed while the running process still presented the REVOKED credential.
  const saved = { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SENTINEL }
  const running = { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: OLD_SENTINEL }
  const r = entraRestartPending(saved, running)
  assert.equal(r.pending, true, 'a rotation owes a restart')
  assert.deepEqual(r.fields, [ENTRA_FIELD_LABELS.ENTRA_CLIENT_SECRET])

  // Each field in turn, so no one of the three is silently excluded.
  for (const key of ENTRA_KEYS) {
    const one = entraRestartPending({ ...saved, [key]: 'changed-value' }, saved)
    assert.equal(one.pending, true, key)
    assert.deepEqual(one.fields, [ENTRA_FIELD_LABELS[key]], key)
  }
})

test('restart-pending is clear when saved and running agree, and reports the first-ever configure', () => {
  const saved = { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SENTINEL }
  assert.deepEqual(entraRestartPending(saved, saved), { pending: false, fields: [] })
  // Whitespace and absent-vs-blank are the same fact, not a pending restart.
  assert.deepEqual(
    entraRestartPending({ ENTRA_TENANT_ID: ` ${TENANT} ` }, { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: '' }),
    { pending: false, fields: [] },
  )
  assert.deepEqual(entraRestartPending({}, {}), { pending: false, fields: [] })
  assert.deepEqual(entraRestartPending(null, undefined), { pending: false, fields: [] })

  // A first-ever configure: saved has all three, the process has none.
  const first = entraRestartPending(saved, {})
  assert.equal(first.pending, true)
  assert.deepEqual(first.fields, ENTRA_KEYS.map((k) => ENTRA_FIELD_LABELS[k]))
})

// ── ⛔ THE SECRET NEVER TRAVELS ─────────────────────────────────────────────

test('NO SECRET VALUE APPEARS IN ANY RESPONSE-SHAPED RESULT OR ERROR STRING', () => {
  const leaked: string[] = []
  const check = (label: string, value: unknown) => {
    const s = JSON.stringify(value) ?? ''
    for (const [name, secret] of [
      ['the submitted secret', SENTINEL],
      ['the stored secret', OLD_SENTINEL],
    ] as const) {
      if (s.includes(secret)) leaked.push(`${label} carried ${name}`)
    }
  }

  // 1. Every plan refusal, with the sentinel in EACH field in turn — because
  //    the commonest way to fail validation is to paste the secret into an id
  //    box, and a refusal that quoted its input to explain the shape would be a
  //    refusal that leaked a credential.
  //    ⛔ This loop does NOT assert that these bodies are refused. The
  //    validation tests above own that, and asserting it here as a precondition
  //    would make THIS test fail whenever a validation is dropped — a test that
  //    breaks for the wrong reason gets waived. It checks only for a leak, so a
  //    failure here means exactly one thing.
  for (const body of [
    { tenantId: SENTINEL, clientId: CLIENT, clientSecret: SENTINEL },
    { tenantId: TENANT, clientId: SENTINEL, clientSecret: SENTINEL },
    { tenantId: SENTINEL, clientId: SENTINEL },
    { tenantId: TENANT, clientId: CLIENT, clientSecret: `${SENTINEL}\nsecond line` },
    { tenantId: TENANT, clientId: CLIENT, clientSecret: '   ' },
    { tenantId: '', clientId: '' },
  ]) {
    const plan = planEntraWrite(normaliseEntraInput(body), { storedSecret: true })
    const label = `plan for ${JSON.stringify(body).replace(SENTINEL, '<sentinel>')}`
    // `writes` is instruction-shaped and carries the value by necessity; every
    // other field of the plan, and every field of a refusal, is response-shaped.
    check(label, plan.ok ? { ...plan, writes: plan.writes.map((w) => w.key) } : plan)
  }

  // 2. The apply outcome at every failure point, from a writer that both
  //    reports its own `previous` (which IS the old secret) and echoes the
  //    value it tried to write into its error.
  for (let failAt = 1; failAt <= 4; failAt++) {
    const w = makeWriter({ env: liveEnv(), failAt, echoValueInError: true, reportPrevious: true })
    const outcome = applyEntraWrites(fullPlan().writes, w.write)
    check(`apply outcome (failAt=${failAt})`, outcome)
    const answer = entraWriteFailureAnswer(outcome as Extract<typeof outcome, { ok: false }>)
    check(`failure answer (failAt=${failAt})`, answer)
    check(`failure answer error string (failAt=${failAt})`, answer.error)
  }

  // 3. A successful apply, from the same leaky writer.
  const okW = makeWriter({ env: liveEnv(), reportPrevious: true })
  check('successful apply outcome', applyEntraWrites(fullPlan().writes, okW.write))

  // 4. A throwing writer whose exception message carries the value.
  const thrower: EntraWriter = (key, value) => {
    throw new Error(`failed to persist ${key}=${value}`)
  }
  const thrown = applyEntraWrites(fullPlan().writes, thrower)
  check('throwing-writer outcome', thrown)
  check('throwing-writer failure answer', entraWriteFailureAnswer(thrown as Extract<typeof thrown, { ok: false }>))

  // 5. The saved-vs-running comparison, which must hold BOTH secrets to do its
  //    job and may return only the label of the difference.
  const restart = entraRestartPending(
    { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SENTINEL },
    { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: OLD_SENTINEL },
  )
  check('restart-pending', restart)

  // 6. The duplicate scan, over a file that really holds a secret.
  check(
    'duplicate scan',
    duplicateEntraKeys(`ENTRA_CLIENT_SECRET=${OLD_SENTINEL}\nENTRA_CLIENT_SECRET=${SENTINEL}\n`),
  )

  assert.deepEqual(leaked, [], `a secret value travelled: ${leaked.join('; ')}`)
})

test("a writer's own `previous` and value-echoing error never reach the outcome", () => {
  // Stated separately from the sweep above, as the named reason: writeManagedKey
  // returns `previous` at the top level and again per-file inside `results`, and
  // for ENTRA_CLIENT_SECRET that is the OLD SECRET. Picking fields rather than
  // spreading the result is what keeps it out.
  const w = makeWriter({ env: liveEnv(), failAt: 2, echoValueInError: true, reportPrevious: true })
  const outcome = applyEntraWrites(fullPlan().writes, w.write) as Extract<
    ReturnType<typeof applyEntraWrites>,
    { ok: false }
  >
  assert.deepEqual(Object.keys(outcome).sort(), ['backupPath', 'changed', 'error', 'failedKey', 'landed', 'ok'])
  assert.ok(!('previous' in outcome), 'the writer `previous` is not forwarded')
  assert.ok(outcome.error.includes('[value redacted]'), 'an echoed value is redacted, not forwarded')
  assert.ok(!outcome.error.includes(SENTINEL))

  const answer = entraWriteFailureAnswer(outcome)
  assert.ok(!('previous' in answer))
  assert.ok(!answer.error.includes(SENTINEL))
})

test('the plan carries the secret ONLY in the one write that must have it', () => {
  const plan = fullPlan(SENTINEL)
  // It is instruction-shaped, so the value is present by necessity — but in
  // exactly one slot, and nowhere else in the object.
  const slots = plan.writes.filter((w) => w.value === SENTINEL)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].key, 'ENTRA_CLIENT_SECRET')

  const withoutWrites = { ...plan, writes: plan.writes.map((w) => w.key) }
  assert.ok(
    !JSON.stringify(withoutWrites).includes(SENTINEL),
    'the secret is not echoed into any other field of the plan',
  )
  // And the booleans a route reports are facts ABOUT the secret, not the secret.
  assert.equal(plan.secretReplaced, true)
  assert.equal(plan.secretCleared, false)
})

// ── labels ──────────────────────────────────────────────────────────────────

test('every key has a label, because labels are the only thing allowed to travel', () => {
  for (const k of ENTRA_KEYS) {
    assert.equal(typeof ENTRA_FIELD_LABELS[k], 'string')
    assert.ok(ENTRA_FIELD_LABELS[k].length > 0, k)
  }
  assert.equal(new Set(Object.values(ENTRA_FIELD_LABELS)).size, ENTRA_KEYS.length, 'labels are distinct')
  // A failed write of an unlabelled key still answers with something usable.
  const answer = entraWriteFailureAnswer({
    ok: false,
    failedKey: 'ENTRA_SOMETHING_NEW' as EntraKey,
    error: 'nope',
    backupPath: null,
    landed: [],
    changed: [],
  })
  assert.equal(answer.failedField, 'ENTRA_SOMETHING_NEW')
})
