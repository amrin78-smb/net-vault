import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MANAGED_KEYS,
  isManagedKey,
  resolveEnvTargets,
  parseServiceEnvKeys,
  serviceEnvPins,
  shadowVerdict,
  writeManagedKey,
  rootEnvPath,
  standaloneEnvPath,
} from '../lib/envTargets.ts'
import { readEnvFile } from '../lib/envFile.ts'

/** A fake repo: a .git marker so findGitRoot stops here, plus the env files. */
function fakeRepo(opts: { root?: string; standalone?: string | null } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-envtargets-'))
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, '.env'), opts.root ?? 'NEXTAUTH_URL=http://10.0.0.1:3000\n')
  if (opts.standalone !== null) {
    const sd = path.join(dir, '.next', 'standalone')
    fs.mkdirSync(sd, { recursive: true })
    fs.writeFileSync(path.join(sd, '.env.local'), opts.standalone ?? 'NEXTAUTH_URL=http://10.0.0.1:3000\n')
  }
  return dir
}

// ── the allow-list ──────────────────────────────────────────────────────────

test('only managed keys may be written from a request', () => {
  assert.equal(isManagedKey('NEXTAUTH_URL'), true)
  assert.equal(isManagedKey('ENTRA_CLIENT_SECRET'), true)
  // The two that must never be reachable from an HTTP route.
  assert.equal(isManagedKey('NEXTAUTH_SECRET'), false)
  assert.equal(isManagedKey('DATABASE_URL'), false)
  assert.throws(() => resolveEnvTargets('DATABASE_URL'), /not a managed setting/)
  assert.throws(() => resolveEnvTargets('NEXTAUTH_SECRET'), /not a managed setting/)
})

test('every managed key is one this module can actually resolve targets for', () => {
  for (const k of MANAGED_KEYS) assert.equal(resolveEnvTargets(k).length, 2, k)
})

// ── target order ────────────────────────────────────────────────────────────

test('the deploy source is written first, the runtime file second', () => {
  const dir = fakeRepo()
  const targets = resolveEnvTargets('NEXTAUTH_URL', dir)
  assert.equal(targets[0].role, 'deploy-source')
  assert.equal(targets[0].path, rootEnvPath(dir))
  assert.equal(targets[1].role, 'running')
  assert.equal(targets[1].path, standaloneEnvPath(dir))
  // Only the runtime file may be absent — a dev checkout has never been built.
  assert.equal(targets[0].optionalIfMissing, false)
  assert.equal(targets[1].optionalIfMissing, true)
})

// ── the shadow verdict: three states, and `unknown` is never `clear` ────────

test('parseServiceEnvKeys returns KEY NAMES ONLY — no value may escape', () => {
  // A realistic AppEnvironmentExtra, carrying the two secrets it really holds.
  const out =
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\NetVault\\Parameters\r\n' +
    '    AppEnvironmentExtra    REG_MULTI_SZ    PORT=3000\\0' +
    'DATABASE_URL=postgresql://netvault:sup3rs3cret@localhost:5432/netvault\\0' +
    'NEXTAUTH_SECRET=thisMustNeverLeak\\0NEXTAUTH_URL=http://10.0.0.1:3000\r\n'
  const keys = parseServiceEnvKeys(out)
  assert.deepEqual(keys, ['PORT', 'DATABASE_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL'])
  const serialised = JSON.stringify(keys)
  assert.ok(!serialised.includes('sup3rs3cret'), 'the DB password must not travel')
  assert.ok(!serialised.includes('thisMustNeverLeak'), 'NEXTAUTH_SECRET must not travel')
  assert.ok(!serialised.includes('postgresql://'), 'no value fragment at all')
})

test('parseServiceEnvKeys returns null when the value is absent', () => {
  assert.equal(parseServiceEnvKeys('ERROR: The system was unable to find the specified value.'), null)
  assert.equal(parseServiceEnvKeys(''), null)
})

test('serviceEnvPins returns null off Windows — NOT an empty array', () => {
  // ⛔ The distinction this whole type exists for. `[]` would read as "nothing
  // is pinned, your write will take effect", which is a failed read recorded as
  // an affirmative answer.
  const r = serviceEnvPins('NetVault', () => 'unused', 'linux')
  assert.equal(r, null)
})

test('serviceEnvPins returns null when the registry query throws', () => {
  const r = serviceEnvPins(
    'NetVault',
    () => {
      throw new Error('Access is denied.')
    },
    'win32',
  )
  assert.equal(r, null)
})

test('serviceEnvPins parses a real value on Windows', () => {
  const r = serviceEnvPins(
    'NetVault',
    () => '    AppEnvironmentExtra    REG_MULTI_SZ    PORT=3000\\0NEXTAUTH_URL=http://x:3000\r\n',
    'win32',
  )
  assert.deepEqual(r, ['PORT', 'NEXTAUTH_URL'])
})

test('shadowVerdict: null pins resolve to unknown, never clear', () => {
  const v = shadowVerdict('NEXTAUTH_URL', 'NetVault', null)
  assert.equal(v.state, 'unknown')
  assert.notEqual(v.state, 'clear')
  assert.ok(v.state === 'unknown' && v.reason.length > 0, 'the reason must be stated')
})

test('shadowVerdict: a pinned key is shadowed — a file write cannot take effect', () => {
  const v = shadowVerdict('NEXTAUTH_URL', 'NetVault', ['PORT', 'NEXTAUTH_URL'])
  assert.equal(v.state, 'shadowed')
})

test('shadowVerdict: an unpinned key is clear', () => {
  assert.equal(shadowVerdict('NEXTAUTH_URL', 'NetVault', ['PORT']).state, 'clear')
})

// ── the write ───────────────────────────────────────────────────────────────

test('writes both files and reports the deploy source as previous', () => {
  const dir = fakeRepo()
  const r = writeManagedKey('NEXTAUTH_URL', 'https://nv.example.com:3000', {
    cwd: dir,
    pins: ['PORT'],
  })
  assert.equal(r.ok, true)
  assert.equal(r.previous, 'http://10.0.0.1:3000')
  assert.equal(readEnvFile(rootEnvPath(dir)).values.NEXTAUTH_URL, 'https://nv.example.com:3000')
  assert.equal(readEnvFile(standaloneEnvPath(dir)).values.NEXTAUTH_URL, 'https://nv.example.com:3000')
  assert.equal(r.shadow.state, 'clear')
})

test('a missing standalone runtime file is skipped, not fatal', () => {
  const dir = fakeRepo({ standalone: null })
  const r = writeManagedKey('NEXTAUTH_URL', 'https://y:3000', { cwd: dir, pins: ['PORT'] })
  assert.equal(r.ok, true)
  assert.equal(r.results[1].result, 'skipped-missing')
  assert.equal(readEnvFile(rootEnvPath(dir)).values.NEXTAUTH_URL, 'https://y:3000')
})

test('a shadowed key still writes, but the verdict says it will not take effect', () => {
  // ⛔ It writes rather than refusing because the file IS the durable record and
  // the shadow is removable by the installer/updater. What must never happen is
  // reporting plain success — the caller renders this verdict.
  const dir = fakeRepo()
  const r = writeManagedKey('NEXTAUTH_URL', 'https://y:3000', {
    cwd: dir,
    pins: ['NEXTAUTH_URL'],
  })
  assert.equal(r.ok, true)
  assert.equal(r.shadow.state, 'shadowed')
})

test('a duplicated key in the deploy source fails the write and names it', () => {
  const dir = fakeRepo({ root: 'NEXTAUTH_URL=http://a:3000\nNEXTAUTH_URL=http://b:3000\n' })
  const r = writeManagedKey('NEXTAUTH_URL', 'https://y:3000', { cwd: dir, pins: ['PORT'] })
  assert.equal(r.ok, false)
  assert.match(r.error || '', /appears 2 times/)
})

test('an absent deploy source is fatal — the setting would have nowhere durable to live', () => {
  const dir = fakeRepo()
  fs.rmSync(rootEnvPath(dir))
  const r = writeManagedKey('NEXTAUTH_URL', 'https://y:3000', { cwd: dir, pins: ['PORT'] })
  assert.equal(r.ok, false)
  assert.match(r.error || '', /nowhere durable/)
})

test('clearing a key writes an empty value rather than removing the line', () => {
  // Turning Entra off is "clear all three", and an absent key and an empty one
  // must mean the same thing to isEntraConfigured.
  const dir = fakeRepo({ root: 'ENTRA_TENANT_ID=abc\n', standalone: 'ENTRA_TENANT_ID=abc\n' })
  const r = writeManagedKey('ENTRA_TENANT_ID', '', { cwd: dir, pins: ['PORT'] })
  assert.equal(r.ok, true)
  assert.equal(readEnvFile(rootEnvPath(dir)).values.ENTRA_TENANT_ID, '')
})
