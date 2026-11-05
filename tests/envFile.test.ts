import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseEnv, readEnvFile, setEnvValue, LINE_RE } from '../lib/envFile.ts'

function tmpEnv(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-envfile-'))
  const p = path.join(dir, '.env')
  fs.writeFileSync(p, contents)
  return p
}

function backupsIn(p: string): string[] {
  return fs.readdirSync(path.dirname(p)).filter((f) => f.endsWith('.bak'))
}

// ── CRLF, which is the shipped shape on Windows ──────────────────────────────
//
// ⛔ THESE ASSERT BYTE-FOR-BYTE EQUALITY, AND THE FIRST DRAFT DID NOT — IT
// CHECKED `includes('\r\n')` AND "no bare LF", AND BOTH SURVIVE REAL
// CORRUPTION. Mutation-verified: replacing `split(/\r?\n/)` with `split('\n')`
// leaves the `\r` on every untouched line and then joins with `\r\n`, so the
// whole file becomes `\r\r\n` — and the old assertions passed, because the
// character before each `\n` was still a `\r`. Comparing the exact bytes is the
// only form of this test that fails on that mutation.

test('CRLF: only the one line changes, byte for byte', () => {
  const original = '# hub\r\nNEXTAUTH_URL=http://10.0.0.1:3000\r\nNEXTAUTH_SECRET=abc\r\n'
  const p = tmpEnv(original)
  const r = setEnvValue(p, 'NEXTAUTH_URL', 'https://nv.example.com:3000')
  assert.equal(r.ok, true)
  assert.equal(
    fs.readFileSync(p, 'utf8'),
    original.replace('http://10.0.0.1:3000', 'https://nv.example.com:3000'),
    'a CRLF file must come back with CRLF endings and no doubled \\r',
  )
  assert.equal(parseEnv(fs.readFileSync(p, 'utf8')).NEXTAUTH_URL, 'https://nv.example.com:3000')
})

test('CRLF: the key is replaced in place, never appended as a duplicate', () => {
  const p = tmpEnv('# hub\r\nNEXTAUTH_URL=http://10.0.0.1:3000\r\nNEXTAUTH_SECRET=abc\r\n')
  setEnvValue(p, 'NEXTAUTH_URL', 'https://nv.example.com:3000')
  const hits = fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('NEXTAUTH_URL='))
  assert.equal(hits.length, 1, 'exactly one NEXTAUTH_URL line must remain')
})

// ⛔ LINE_RE IS EXPORTED AND MATCHED AGAINST RAW LINES BY OTHER MODULES (the
// Entra duplicate-key scan takes it from here rather than declaring a second
// regex for the same grammar). setEnvValue pre-splits on /\r?\n/, so the `\r?`
// is defensive THERE — it is load-bearing for those consumers, and this test is
// what holds it, since no test of setEnvValue can.
test('LINE_RE matches a raw CRLF line without swallowing the \\r into the value', () => {
  const m = LINE_RE.exec('NEXTAUTH_URL=http://x:3000\r')
  assert.ok(m, 'a raw CRLF line must match')
  assert.equal(m![1], 'NEXTAUTH_URL')
  assert.equal(m![2], 'http://x:3000', 'the \\r must not land in the value')
})

test('LF file stays LF', () => {
  const p = tmpEnv('A=1\nNEXTAUTH_URL=http://x:3000\n')
  setEnvValue(p, 'NEXTAUTH_URL', 'https://y:3000')
  assert.ok(!fs.readFileSync(p, 'utf8').includes('\r'))
})

// ── nothing else may move ───────────────────────────────────────────────────

test('comments, blank lines, ordering and every other value survive byte for byte', () => {
  const original = [
    '# NocVault hub',
    '',
    'DATABASE_URL=postgresql://netvault:p%40ss=word@localhost:5432/netvault',
    'NEXTAUTH_SECRET=s3cret==',
    '# the console address',
    'NEXTAUTH_URL=http://10.0.0.1:3000',
    '',
    'CRON_SECRET=xyz',
    '',
  ].join('\n')
  const p = tmpEnv(original)
  const r = setEnvValue(p, 'NEXTAUTH_URL', 'https://nv.example.com:3000')
  assert.equal(r.ok, true)
  const after = fs.readFileSync(p, 'utf8')
  assert.equal(
    after,
    original.replace('NEXTAUTH_URL=http://10.0.0.1:3000', 'NEXTAUTH_URL=https://nv.example.com:3000'),
    'only the one line may differ',
  )
})

test("a value containing '=' round-trips (DATABASE_URL, base64 secrets)", () => {
  const p = tmpEnv('NEXTAUTH_SECRET=abc==\nNEXTAUTH_URL=http://x:3000\n')
  setEnvValue(p, 'NEXTAUTH_URL', 'https://y:3000')
  assert.equal(readEnvFile(p).values.NEXTAUTH_SECRET, 'abc==')
})

test('appends when the key is absent, without disturbing the trailing newline', () => {
  const p = tmpEnv('A=1\n')
  const r = setEnvValue(p, 'ENTRA_TENANT_ID', 'd0d0d0d0-0000-0000-0000-000000000000')
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.previous, null, 'previous must be null for a key that did not exist')
  assert.equal(readEnvFile(p).values.ENTRA_TENANT_ID, 'd0d0d0d0-0000-0000-0000-000000000000')
  assert.equal(readEnvFile(p).values.A, '1')
})

// ── the refusals ────────────────────────────────────────────────────────────

test('a duplicated key is refused and leaves no backup behind', () => {
  const p = tmpEnv('NEXTAUTH_URL=http://a:3000\nB=2\nNEXTAUTH_URL=http://b:3000\n')
  const r = setEnvValue(p, 'NEXTAUTH_URL', 'https://c:3000')
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : '', /appears 2 times/)
  assert.match(r.ok === false ? r.error : '', /lines 1, 3/)
  assert.deepEqual(backupsIn(p), [], 'a refusal that changes nothing must not orphan a backup')
  assert.ok(fs.readFileSync(p, 'utf8').includes('http://a:3000'), 'file untouched')
})

test('a value containing a line break is refused', () => {
  const p = tmpEnv('NEXTAUTH_URL=http://x:3000\n')
  const r = setEnvValue(p, 'NEXTAUTH_URL', 'https://y:3000\nEVIL=1')
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : '', /line break/)
  assert.equal(readEnvFile(p).values.EVIL, undefined, 'no key may be injected')
})

test('an invalid key is refused', () => {
  const p = tmpEnv('A=1\n')
  const r = setEnvValue(p, 'NOT A KEY', 'x')
  assert.equal(r.ok, false)
})

test('the size tripwire refuses before taking a backup', () => {
  // 1 MB + a bit, which readFileSync handles fine — so without the tripwire
  // this would be copied in full into a secret-bearing .bak and rewritten.
  const p = tmpEnv(`NEXTAUTH_URL=http://x:3000\n# ${'x'.repeat(1024 * 1024)}\n`)
  const r = setEnvValue(p, 'NEXTAUTH_URL', 'https://y:3000')
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : '', /probably corrupt|far larger/)
  assert.deepEqual(backupsIn(p), [], 'a corrupt file must not be duplicated first')
})

// ── the backup lifecycle ────────────────────────────────────────────────────

test('the backup is removed once the write is verified', () => {
  const p = tmpEnv('NEXTAUTH_URL=http://x:3000\nNEXTAUTH_SECRET=keepme\n')
  const r = setEnvValue(p, 'NEXTAUTH_URL', 'https://y:3000')
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.backupPath, null, 'no backup path is reported on success')
  assert.deepEqual(
    backupsIn(p),
    [],
    'a backup left on the success path is a permanent second copy of every secret',
  )
})

test('an unchanged value is a no-op and takes no backup', () => {
  const p = tmpEnv('NEXTAUTH_URL=https://y:3000\n')
  const r = setEnvValue(p, 'NEXTAUTH_URL', 'https://y:3000')
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.unchanged, true)
  assert.deepEqual(backupsIn(p), [])
})

test('previous is reported so the operator can get back', () => {
  const p = tmpEnv('NEXTAUTH_URL=http://old:3000\n')
  const r = setEnvValue(p, 'NEXTAUTH_URL', 'https://new:3000')
  assert.equal(r.ok && r.previous, 'http://old:3000')
})

// ── parseEnv ────────────────────────────────────────────────────────────────

test('parseEnv strips one wrapping pair of quotes and ignores comments', () => {
  const v = parseEnv('# c\nA="has spaces"\nB=\'single\'\n#D=4\nE=plain\n')
  assert.equal(v.A, 'has spaces')
  assert.equal(v.B, 'single')
  assert.equal(v.D, undefined)
  assert.equal(v.E, 'plain')
})

test('parseEnv tolerates a leading `export `', () => {
  assert.equal(parseEnv('export A=1\n').A, '1')
})

test('parseEnv reads the LAST occurrence, which is what dotenv does', () => {
  // Pinned deliberately: setEnvValue REFUSES a duplicate precisely because this
  // disagrees with Update-NetVault.ps1's `Select-Object -First 1`.
  assert.equal(parseEnv('A=first\nA=last\n').A, 'last')
})
