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
  buildPinUpdateScript,
  duplicateKeyPreflight,
  parsePinUpdateOutput,
  parseServiceAppDirectory,
  readServiceParams,
  resolveConsoleEnvTargets,
  serviceAppDirectory,
  updateServiceEnvPin,
  writeConsoleKey,
  type PinOutcome,
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

// ─── finding the OTHER THREE consoles ───────────────────────────────────────
//
// ⛔ THE HUB HAS NO RUNTIME KNOWLEDGE OF SATELLITE INSTALL PATHS, AND THE PATHS
// ARE NOT UNIFORM: `C:\Apps\NetVault\app` and `C:\Apps\SpanVault\app`, but
// `C:\Apps\logvault` and `C:\Apps\ddivault` with no `app` subfolder. Every test
// below exists because a hub that pattern-matched a path would write a console
// address into a directory that does not exist on half the installs — and
// report success.

const REG_APPDIR = (value: string, type = 'REG_SZ') =>
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\LogVault-App\\Parameters\r\n'
  + `    AppDirectory    ${type}    ${value}\r\n`

test('parseServiceAppDirectory reads REG_SZ and REG_EXPAND_SZ, and expands NEITHER', () => {
  assert.equal(parseServiceAppDirectory(REG_APPDIR('C:\\Apps\\logvault\\frontend')), 'C:\\Apps\\logvault\\frontend')
  // ⛔ NOT EXPANDED. Expanding would mean resolving ANOTHER process's
  // environment from this one, and a wrong guess invents a directory. The
  // unexpanded string is the honest answer; a write against it fails loudly.
  assert.equal(
    parseServiceAppDirectory(REG_APPDIR('%SystemDrive%\\Apps\\logvault\\frontend', 'REG_EXPAND_SZ')),
    '%SystemDrive%\\Apps\\logvault\\frontend',
  )
  assert.equal(parseServiceAppDirectory(REG_APPDIR('C:\\Apps\\SpanVault\\app\\frontend')), 'C:\\Apps\\SpanVault\\app\\frontend')
})

test('parseServiceAppDirectory returns null for an absent or empty value — never a guess', () => {
  assert.equal(parseServiceAppDirectory('ERROR: The system was unable to find the specified value.'), null)
  assert.equal(parseServiceAppDirectory(''), null)
  assert.equal(parseServiceAppDirectory(REG_APPDIR('')), null)
})

test('serviceAppDirectory is TRI-STATE: a path, or null for every kind of failed read', () => {
  // ⛔ `null` IS "WE COULD NOT LOCATE IT", AND IT IS NEVER A FALLBACK PATH. Off
  // Windows there is no registry; without Administrator the query is refused;
  // the service may not be installed. All three must read as unknown, because
  // the alternative — a guessed path — writes a console address somewhere
  // nobody will look and calls it saved.
  assert.equal(serviceAppDirectory('LogVault-App', () => REG_APPDIR('C:\\Apps\\logvault\\frontend'), 'linux'), null)
  assert.equal(serviceAppDirectory('LogVault-App', () => { throw new Error('Access is denied.') }, 'win32'), null)
  assert.equal(serviceAppDirectory('LogVault-App', () => 'ERROR: The system was unable to find the specified key.', 'win32'), null)
  assert.equal(
    serviceAppDirectory('LogVault-App', () => REG_APPDIR('C:\\Apps\\logvault\\frontend'), 'win32'),
    'C:\\Apps\\logvault\\frontend',
  )
})

test('serviceAppDirectory is a SEPARATE function from parseServiceEnvKeys', () => {
  // ⛔ `parseServiceEnvKeys` DELIBERATELY DISCARDS EVERY VALUE, because the
  // value it parses carries NEXTAUTH_SECRET, DATABASE_URL and NETVAULT_DB_PASS.
  // Folding the AppDirectory read into it would create one function that
  // sometimes returns values out of that string. Prove they cannot be confused:
  // neither parser reads the other's value.
  assert.equal(parseServiceAppDirectory('    AppEnvironmentExtra    REG_MULTI_SZ    NEXTAUTH_URL=http://x:3000'), null)
  assert.equal(parseServiceEnvKeys(REG_APPDIR('C:\\Apps\\logvault\\frontend')), null)
})

test('readServiceParams fails each half INDEPENDENTLY, and is null/null off Windows', async () => {
  // ⛔ TWO DIFFERENT FACTS WITH TWO DIFFERENT CONSEQUENCES: "we could not read
  // where LogVault is installed" and "we could not read whether it pins this
  // key". One failing must not be reported as the other failing.
  assert.deepEqual(await readServiceParams('LogVault-App', async () => 'unused', 'linux'), {
    pins: null,
    appDirectory: null,
  })
  const halfBroken = await readServiceParams(
    'LogVault-App',
    async (_svc, value) => {
      if (value === 'AppDirectory') return REG_APPDIR('C:\\Apps\\logvault\\frontend')
      throw new Error('Access is denied.')
    },
    'win32',
  )
  assert.equal(halfBroken.appDirectory, 'C:\\Apps\\logvault\\frontend')
  assert.equal(halfBroken.pins, null, 'an unreadable pin list is unknown, not empty')
})

test('a satellite\'s two files are derived from AppDirectory — on BOTH install layouts', () => {
  // ⛔ THIS IS THE WHOLE POINT OF READING THE SERVICE. `next start` dotenv-loads
  // from its own cwd, so `<AppDirectory>\.env.local` is the RUNNING file and
  // `<parent>\.env.local` is the deploy source — identical arithmetic whether
  // the root is `C:\Apps\SpanVault\app` or `C:\Apps\logvault`.
  const span = resolveConsoleEnvTargets('spanvault', 'C:\\Apps\\SpanVault\\app\\frontend')
  assert.deepEqual(span.map((t) => [t.role, t.path]), [
    ['deploy-source', 'C:\\Apps\\SpanVault\\app\\.env.local'],
    ['running', 'C:\\Apps\\SpanVault\\app\\frontend\\.env.local'],
  ])
  const lv = resolveConsoleEnvTargets('logvault', 'C:\\Apps\\logvault\\frontend')
  assert.deepEqual(lv.map((t) => [t.role, t.path]), [
    ['deploy-source', 'C:\\Apps\\logvault\\.env.local'],
    ['running', 'C:\\Apps\\logvault\\frontend\\.env.local'],
  ])
  // ⛔ DEPLOY SOURCE FIRST, AND ONLY THE RUNNING FILE MAY BE MISSING.
  // `Update-DDIVault.ps1` copies the root `.env.local` over
  // `frontend\.env.local` on EVERY run, so a running-file-only write silently
  // reverts at the next deploy with nothing reporting it at the time.
  assert.equal(lv[0].optionalIfMissing, false)
  assert.equal(lv[1].optionalIfMissing, true)
})

test('a POSIX AppDirectory is handled too, because node:path is the wrong tool here', () => {
  // ⛔ `path.dirname('C:\\Apps\\x\\frontend')` ON LINUX RETURNS THE WHOLE STRING,
  // which would make the deploy-source target identical to the running one —
  // two writes to one file, and the deploy source never updated.
  const posix = resolveConsoleEnvTargets('ddivault', '/opt/ddivault/frontend')
  assert.deepEqual(posix.map((t) => t.path), ['/opt/ddivault/.env.local', '/opt/ddivault/frontend/.env.local'])
})

test('resolveConsoleEnvTargets REFUSES the hub, and refuses a rootless path', () => {
  // ⛔ THE HUB'S AppDirectory IS `<root>\.next\standalone`, whose parent is the
  // BUILD OUTPUT `git clean` removes. The hub knows its own repo root and uses
  // resolveEnvTargets; deriving it from the registry would be wrong for exactly
  // one of the four consoles, which is the worst number.
  assert.throws(() => resolveConsoleEnvTargets('netvault', 'C:\\Apps\\NetVault\\app\\.next\\standalone'), /repo root/)
  assert.throws(() => resolveConsoleEnvTargets('logvault', 'C:\\'), /no parent directory/)
  assert.throws(() => resolveConsoleEnvTargets('logvault', ''), /No AppDirectory/)
})

// ─── the duplicate pre-flight ───────────────────────────────────────────────

test('the pre-flight finds a duplicate in EITHER file before anything is written', () => {
  // ⛔ A REFUSAL MUST NOT LAND MID-SEQUENCE: a duplicate in the SECOND file
  // would refuse after the first had been rewritten, leaving the deploy source
  // and the running file disagreeing about the address of a console.
  const dir = fakeRepo({ standalone: 'NEXTAUTH_URL=http://a:3000\nNEXTAUTH_URL=http://b:3000\n' })
  const targets = resolveEnvTargets('NEXTAUTH_URL', dir)
  const problem = duplicateKeyPreflight(targets, 'NEXTAUTH_URL')
  assert.equal(problem?.kind, 'duplicate')
  assert.equal(problem?.path, standaloneEnvPath(dir))
  // The first file was NOT touched by the scan.
  assert.equal(readEnvFile(rootEnvPath(dir)).values.NEXTAUTH_URL, 'http://10.0.0.1:3000')
  assert.equal(duplicateKeyPreflight(resolveEnvTargets('NEXTAUTH_URL', fakeRepo()), 'NEXTAUTH_URL'), null)
})

test('an UNREADABLE file is its own pre-flight problem, not a duplicate', () => {
  const dir = fakeRepo()
  const problem = duplicateKeyPreflight(resolveEnvTargets('NEXTAUTH_URL', dir), 'NEXTAUTH_URL', {
    existsSync: () => true,
    readFileSync: () => { throw new Error('EBUSY') },
  })
  assert.equal(problem?.kind, 'unreadable')
})

// ─── the NSSM pin ───────────────────────────────────────────────────────────

test('the pin script edits ONE entry and never echoes a value', () => {
  // ⛔ THE ARRAY IT EDITS HOLDS NEXTAUTH_SECRET, DATABASE_URL AND
  // NETVAULT_DB_PASS. The edit happens INSIDE PowerShell so those values never
  // enter this process at all — and the script must print verdict tokens only.
  const script = buildPinUpdateScript({
    serviceName: 'LogVault-App',
    key: 'NEXTAUTH_URL',
    value: 'https://console.example.com:3004',
  })
  const printed = [...script.matchAll(/Write-Output ('[^']*')/g)].map((m) => m[1])
  assert.ok(printed.length >= 6, 'every branch must say something')
  for (const line of printed) {
    assert.match(line, /^'\[NV-PIN\] [a-z-]+'$/, `a branch printed something other than a verdict: ${line}`)
  }
  // It replaces exactly one entry, keeps the rest verbatim, and verifies itself.
  assert.match(script, /\$after\.Add\(\$name \+ "=" \+ \$new\)/)
  assert.match(script, /else \{ \$after\.Add\(\[string\]\$before\[\$i\]\) \}/)
  assert.match(script, /if \(\$check\.Count -ne \$afterArr\.Count\)/, 'it reads back what it wrote')
  assert.match(script, /Set-ItemProperty[^\n]*-Value \$before -Type MultiString/, 'and restores on a mismatch')
})

test('the pin script NEVER appends a pin that is not already there', () => {
  // ⛔ APPENDING ONE WOULD CREATE THE SHADOWING PROBLEM THE UN-PIN STEP EXISTS
  // TO UNDO. A console that reads its value from a file must keep doing so; the
  // suite's own updaters strip these pins (`Clear-NssmEnvKeys`), and a settings
  // page that re-added one would be fighting the updater.
  const script = buildPinUpdateScript({ serviceName: 'NetVault', key: 'NEXTAUTH_URL', value: 'http://x:3000' })
  assert.match(script, /if \(\$idx -lt 0\) \{ Write-Output '\[NV-PIN\] not-pinned'; exit 0 \}/)
  assert.ok(!/New-ItemProperty/.test(script), 'it must never create the value')
  // An entry it cannot parse as KEY=VALUE is refused rather than round-tripped.
  assert.match(script, /if \(\$eq -lt 1\) \{ Write-Output '\[NV-PIN\] unparsable'; exit 0 \}/)
})

test('parsePinUpdateOutput maps the verdicts and fails closed to unknown', () => {
  assert.equal(parsePinUpdateOutput('[NV-PIN] ok'), 'ok')
  assert.equal(parsePinUpdateOutput('noise\r\n[NV-PIN] unchanged\r\n'), 'unchanged')
  assert.equal(parsePinUpdateOutput('[NV-PIN] not-pinned'), 'not-pinned')
  assert.equal(parsePinUpdateOutput('[NV-PIN] restored'), 'restored')
  assert.equal(parsePinUpdateOutput('[NV-PIN] damaged'), 'damaged')
  // ⛔ ANYTHING ELSE IS A READ WE DID NOT GET — and the caller renders that as
  // still-shadowed, never as applied.
  assert.equal(parsePinUpdateOutput(''), 'unknown')
  assert.equal(parsePinUpdateOutput('Set-ItemProperty : Requested registry access is not allowed.'), 'unknown')
  assert.equal(parsePinUpdateOutput('[NV-PIN] fine'), 'unknown')
})

test('updateServiceEnvPin is unknown off Windows and on a thrown runner', async () => {
  assert.equal(await updateServiceEnvPin('NetVault', 'NEXTAUTH_URL', 'http://x:3000', async () => '[NV-PIN] ok', 'linux'), 'unknown')
  assert.equal(
    await updateServiceEnvPin('NetVault', 'NEXTAUTH_URL', 'http://x:3000', async () => { throw new Error('no powershell') }, 'win32'),
    'unknown',
  )
  // ⛔ AND IT HONOURS THE ALLOW-LIST: a request may not re-pin NEXTAUTH_SECRET.
  await assert.rejects(
    () => updateServiceEnvPin('NetVault', 'NEXTAUTH_SECRET', 'x', async () => '[NV-PIN] ok', 'win32'),
    /not a managed setting/,
  )
})

// ─── one console's write, start to finish ───────────────────────────────────

/** A satellite install: `<root>/.env.local` + `<root>/frontend/.env.local`. */
function fakeSatellite(opts: { root?: string | null; frontend?: string | null } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-satellite-'))
  fs.mkdirSync(path.join(dir, 'frontend'))
  if (opts.root !== null) {
    fs.writeFileSync(path.join(dir, '.env.local'), opts.root ?? 'NEXTAUTH_URL=http://10.0.0.1:3004\n')
  }
  if (opts.frontend !== null) {
    fs.writeFileSync(
      path.join(dir, 'frontend', '.env.local'),
      opts.frontend ?? 'NEXTAUTH_URL=http://10.0.0.1:3004\n',
    )
  }
  return dir
}

test('a satellite write lands in BOTH files, deploy source first', async () => {
  const dir = fakeSatellite()
  const r = await writeConsoleKey('logvault', 'NEXTAUTH_URL', 'https://console.example.com:3004', {
    locate: () => path.join(dir, 'frontend'),
    readPins: () => ['PORT'],
  })
  assert.equal(r.state, 'saved')
  assert.equal(r.takesEffectOnRestart, true)
  assert.deepEqual(r.files.map((f) => f.role), ['deploy-source', 'running'])
  assert.equal(readEnvFile(path.join(dir, '.env.local')).values.NEXTAUTH_URL, 'https://console.example.com:3004')
  assert.equal(
    readEnvFile(path.join(dir, 'frontend', '.env.local')).values.NEXTAUTH_URL,
    'https://console.example.com:3004',
  )
  assert.equal(r.previous, 'http://10.0.0.1:3004')
  // ⛔ THE COLLECTOR READS THIS VALUE TOO (`logvault/collector/emailer.js`
  // builds every alert email's links from it, out of the same file), so it is
  // part of "what has to restart for this to take effect".
  assert.deepEqual(r.restartServices, ['LogVault-App', 'LogVault-Collector'])
})

test('SpanVault\'s write names its API as a service that must restart too', async () => {
  const dir = fakeSatellite()
  const r = await writeConsoleKey('spanvault', 'NEXTAUTH_URL', 'https://console.example.com:3008', {
    locate: () => path.join(dir, 'frontend'),
    readPins: () => ['PORT'],
  })
  // ⛔ `spanvault/api/rbacScope.js` PUTS NEXTAUTH_URL INTO AN SSRF ALLOW-LIST and
  // dotenv-loads the same root `.env.local` this write just changed.
  assert.deepEqual(r.restartServices, ['SpanVault-App', 'SpanVault-API'])
})

test('a console that could not be LOCATED is unknown, writes nothing, and says so', async () => {
  const r = await writeConsoleKey('ddivault', 'NEXTAUTH_URL', 'https://console.example.com:3006', {
    locate: () => null,
    readPins: () => ['PORT'],
  })
  // ⛔ NEVER `saved`, NEVER A GUESSED PATH, AND NEVER `clear`.
  assert.equal(r.state, 'unknown')
  assert.equal(r.url, null)
  assert.equal(r.takesEffectOnRestart, null)
  assert.deepEqual(r.files, [])
  assert.match(String(r.note), /Could not locate DDIVault's environment files/)
  assert.match(String(r.note), /unknown, not a clean state/)
})

test('an UNREADABLE pin list leaves the write done but the outcome unknown', async () => {
  const dir = fakeSatellite()
  const r = await writeConsoleKey('logvault', 'NEXTAUTH_URL', 'https://console.example.com:3004', {
    locate: () => path.join(dir, 'frontend'),
    readPins: () => null,
  })
  // ⛔ "WE DID NOT CHECK" IS NOT "NOTHING IS PINNED". If that service pins the
  // key it wins over both files and the restart changes nothing — so the files
  // are written (they are the durable record) and the outcome is unknown.
  assert.equal(r.state, 'unknown')
  assert.equal(r.takesEffectOnRestart, null)
  assert.equal(readEnvFile(path.join(dir, '.env.local')).values.NEXTAUTH_URL, 'https://console.example.com:3004')
  assert.match(String(r.note), /not a clean bill of health/)
})

test('a PINNED key is re-pinned, and only then does the save count as saved', async () => {
  const dir = fakeSatellite()
  const calls: Array<[string, string, string]> = []
  const r = await writeConsoleKey('logvault', 'NEXTAUTH_URL', 'https://console.example.com:3004', {
    locate: () => path.join(dir, 'frontend'),
    readPins: () => ['PORT', 'NEXTAUTH_URL', 'NEXTAUTH_SECRET'],
    writePin: async (svc, key, value) => { calls.push([svc, key, value]); return 'ok' },
  })
  assert.deepEqual(calls, [['LogVault-App', 'NEXTAUTH_URL', 'https://console.example.com:3004']])
  assert.equal(r.state, 'saved')
  assert.equal(r.takesEffectOnRestart, true)
  assert.match(String(r.note), /pin was updated too/)
})

test('a pin that EXISTS and could not be written reports shadowed, never saved', async () => {
  // ⛔ THE REQUIREMENT, VERBATIM: if a pin exists and cannot be written, that
  // app is `shadowed`. A service environment variable wins over both files, so
  // reporting "saved" would be a success message for a change that will never
  // happen.
  for (const outcome of ['unknown', 'restored', 'damaged', 'unparsable'] as PinOutcome[]) {
    const dir = fakeSatellite()
    const r = await writeConsoleKey('logvault', 'NEXTAUTH_URL', 'https://console.example.com:3004', {
      locate: () => path.join(dir, 'frontend'),
      readPins: () => ['NEXTAUTH_URL'],
      writePin: async () => outcome,
    })
    assert.equal(r.state, 'shadowed', outcome)
    assert.equal(r.takesEffectOnRestart, false, outcome)
    // The files still landed — they are the durable record and the deploy source.
    assert.equal(readEnvFile(path.join(dir, '.env.local')).values.NEXTAUTH_URL, 'https://console.example.com:3004')
  }
})

test('an UNPINNED console is never handed a pin write at all', async () => {
  const dir = fakeSatellite()
  let called = false
  const r = await writeConsoleKey('logvault', 'NEXTAUTH_URL', 'https://console.example.com:3004', {
    locate: () => path.join(dir, 'frontend'),
    readPins: () => ['PORT', 'DATABASE_URL'],
    writePin: async () => { called = true; return 'ok' },
  })
  assert.equal(called, false, 'appending a pin would create the shadowing problem')
  assert.equal(r.state, 'saved')
  assert.equal(r.pin, null)
})

test('a duplicated key in a satellite file refuses THAT console and writes nothing for it', async () => {
  const dir = fakeSatellite({ frontend: 'NEXTAUTH_URL=http://a:3004\nNEXTAUTH_URL=http://b:3004\n' })
  const r = await writeConsoleKey('logvault', 'NEXTAUTH_URL', 'https://console.example.com:3004', {
    locate: () => path.join(dir, 'frontend'),
    readPins: () => ['PORT'],
  })
  assert.equal(r.state, 'failed')
  assert.match(String(r.error), /appears more than once/)
  // ⛔ AND THE PRE-FLIGHT RAN BEFORE THE FIRST WRITE: the deploy source is
  // untouched, so the two files cannot be left disagreeing.
  assert.equal(readEnvFile(path.join(dir, '.env.local')).values.NEXTAUTH_URL, 'http://10.0.0.1:3004')
})

test('a missing satellite deploy source is fatal for that console only', async () => {
  const dir = fakeSatellite({ root: null })
  const r = await writeConsoleKey('logvault', 'NEXTAUTH_URL', 'https://console.example.com:3004', {
    locate: () => path.join(dir, 'frontend'),
    readPins: () => ['PORT'],
  })
  assert.equal(r.state, 'failed')
  assert.match(String(r.error), /nowhere durable/)
})

test('writeConsoleKey honours the allow-list', async () => {
  await assert.rejects(
    () => writeConsoleKey('logvault', 'NEXTAUTH_SECRET', 'x', { locate: () => '/tmp/x/frontend' }),
    /not a managed setting/,
  )
})
