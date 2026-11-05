import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDITED_KEYS,
  PRESENT,
  ABSENT,
  auditValue,
  auditWorthRecording,
} from '../lib/systemAudit.ts'

const SECRET = 'SENTINEL-sup3r-s3cret-value'

// ── the redaction ───────────────────────────────────────────────────────────

test('ALL THREE Entra fields record presence only, never the value', () => {
  // ⛔ Not just the secret. The commonest misconfiguration in this panel is
  // pasting the client secret into an ID box — at which point the value stored
  // under ENTRA_TENANT_ID *is* the secret.
  for (const k of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET']) {
    assert.equal(auditValue(k, SECRET), PRESENT, k)
    assert.equal(auditValue(k, ''), ABSENT, k)
    assert.equal(auditValue(k, null), ABSENT, k)
  }
})

test('no Entra value can reach an audit row, whatever its shape', () => {
  for (const k of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET']) {
    for (const v of [SECRET, 'a', '  padded  ', '11111111-2222-3333-4444-555555555555']) {
      const out = auditValue(k, v)
      assert.ok(out === PRESENT || out === ABSENT, `${k} leaked: ${out}`)
      assert.ok(!out.includes(v.trim()) || v.trim() === '', `${k} leaked its value`)
    }
  }
})

test('non-secret settings DO record their value — that is the point of auditing them', () => {
  // A console address or a certificate path is worth seeing. Redacting
  // everything would make the trail useless.
  assert.equal(auditValue('NEXTAUTH_URL', 'https://nv.example.com:3000'), 'https://nv.example.com:3000')
  assert.equal(auditValue('TLS_CERT_PATH', 'C:\\certs\\nv.crt'), 'C:\\certs\\nv.crt')
  assert.equal(auditValue('NEXTAUTH_URL', ''), ABSENT)
})

test('an unknown key is NOT treated as secret — redaction is an allow-list of the audited set', () => {
  // Stated so the behaviour is deliberate: a key not in VALUE_NEVER_RECORDED
  // records its value. Only AUDITED_KEYS are ever passed in.
  assert.equal(auditValue('SOME_OTHER_KEY', 'visible'), 'visible')
})

test('whitespace is trimmed before deciding presence', () => {
  assert.equal(auditValue('ENTRA_CLIENT_SECRET', '   '), ABSENT)
  assert.equal(auditValue('NEXTAUTH_URL', '   '), ABSENT)
})

// ── what is worth a row ─────────────────────────────────────────────────────

test('A SECRET ROTATION IS RECORDED — the comparison is on RAW values', () => {
  // ⛔ The guard this test exists for. Two different secrets both redact to
  // "(set)", so comparing AFTER redaction would record nothing when a secret is
  // rotated — the change most worth knowing about.
  assert.equal(auditWorthRecording('ENTRA_CLIENT_SECRET', 'old-secret', 'new-secret'), true)
  assert.equal(auditValue('ENTRA_CLIENT_SECRET', 'old-secret'), auditValue('ENTRA_CLIENT_SECRET', 'new-secret'))
})

test('an unchanged value produces no row', () => {
  assert.equal(auditWorthRecording('NEXTAUTH_URL', 'https://a.example.com', 'https://a.example.com'), false)
  assert.equal(auditWorthRecording('ENTRA_CLIENT_SECRET', 'same', 'same'), false)
})

test('whitespace-only differences are not a change', () => {
  assert.equal(auditWorthRecording('NEXTAUTH_URL', ' https://a.example.com ', 'https://a.example.com'), false)
  assert.equal(auditWorthRecording('ENTRA_TENANT_ID', '', '   '), false)
})

test('setting and clearing are both changes', () => {
  assert.equal(auditWorthRecording('ENTRA_TENANT_ID', '', 'abc'), true)
  assert.equal(auditWorthRecording('ENTRA_TENANT_ID', 'abc', ''), true)
  assert.equal(auditWorthRecording('ENTRA_TENANT_ID', null, 'abc'), true)
  assert.equal(auditWorthRecording('ENTRA_TENANT_ID', 'abc', undefined), true)
})

test('every audited key has a defined redaction answer', () => {
  for (const k of AUDITED_KEYS) {
    const out = auditValue(k, 'x')
    assert.ok(typeof out === 'string' && out.length > 0, k)
  }
})
