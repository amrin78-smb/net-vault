//
// tests/agentInstallLinux.test.ts — the Linux agent installer must be valid bash,
// and its systemd unit must carry five directives that are load-bearing for
// reasons no reviewer would guess from reading them.
//
// ⛔ WHY `bash -n` IS THE POINT OF THIS FILE. The installer is a bash script
// written as a TEMPLATE LITERAL INSIDE TYPESCRIPT, so every `$`, `${`, backslash
// and backtick has to survive two layers of escaping. A slip produces a file that
// reviews fine, renders fine, and then fails on the customer's server at the one
// moment nobody is watching. Asserting on substrings alone would not catch it;
// parsing the whole script would.
//
// The unit-directive assertions exist because each one is a silent failure, not a
// loud one — see the comments on each test.
//
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildLinuxInstallScript } from '../lib/agentInstallLinux.ts'

const HUB = 'https://hub.example.test:3000'
const script = buildLinuxInstallScript(HUB)

function writeTemp(contents: string, name = 'install.sh'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-install-sh-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, contents, 'utf8')
  return file
}

test('the generated installer is syntactically valid bash', () => {
  const file = writeTemp(script)
  // `bash -n` parses without executing. This is the assertion that actually
  // defends the double-escaping; everything below is about intent.
  execFileSync('bash', ['-n', file], { stdio: 'pipe' })
})

test('the embedded node snippets are valid JS and contain no apostrophe', () => {
  // Two `node -e '...'` programs are embedded: the manifest reader and the
  // config.json writer. Matching with [^']* is deliberate and doubles as an
  // assertion — a single apostrophe anywhere inside one of them (easily written
  // into a comment, e.g. "the agent's own directory") would TERMINATE the bash
  // single-quoted string and shatter the script. bash -n may still accept the
  // wreckage, so this is the check that catches it.
  const progs = [...script.matchAll(/node -e '([^']*)'/g)].map((m) => m[1])
  assert.equal(progs.length, 2, `expected exactly 2 embedded node programs, found ${progs.length}`)
  for (const p of progs) {
    const f = writeTemp(p, 'embedded.cjs')
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  }
})

test('the hub origin is baked in and is the only origin referenced', () => {
  assert.ok(script.includes(HUB), 'hub origin must be inlined as the HUB_URL default')
  assert.ok(!/localhost:3000/.test(script.replace(/NOCVAULT_HUB_URL/g, '')),
    'no localhost fallback should leak into the delivered script')
})

// ── the five directives that fail SILENTLY if wrong ─────────────────────────

test('Restart=always — on-failure would make every self-update a silent outage', () => {
  assert.match(script, /^Restart=always$/m)
  assert.ok(!/^Restart=on-failure/m.test(script),
    'the updater exits 0 deliberately so the supervisor restarts it into the new build')
})

test('the start limit allows the >=3 restarts the crash-loop rollback needs', () => {
  // agent/core/apply-update.js rolls back only once attempts >= 3. systemd's
  // default burst (5 in 10s) can latch the unit 'failed' before that happens.
  const burst = /^StartLimitBurst=(\d+)$/m.exec(script)
  const interval = /^StartLimitIntervalSec=(\d+)$/m.exec(script)
  assert.ok(burst && interval, 'both StartLimitBurst and StartLimitIntervalSec must be set explicitly')
  assert.ok(Number(burst![1]) >= 3,
    `StartLimitBurst=${burst![1]} is below the 3 restarts the rollback requires`)
})

test('CAP_NET_RAW is granted, because NoNewPrivileges drops ping’s file capability', () => {
  // Without this every ping reports 'down' — a total monitoring failure that
  // reads as a network problem, not a config one.
  assert.match(script, /^AmbientCapabilities=CAP_NET_RAW$/m)
  assert.match(script, /^CapabilityBoundingSet=CAP_NET_RAW$/m)
  assert.match(script, /^NoNewPrivileges=yes$/m)
})

test('ProtectSystem=strict is paired with a writable install dir', () => {
  // The agent writes config.json, hub-identity.json, the offline buffer and the
  // self-update staging dirs into its own directory.
  assert.match(script, /^ProtectSystem=strict$/m)
  assert.match(script, /^ReadWritePaths=/m)
})

test('MemoryDenyWriteExecute is never enabled — it breaks V8’s JIT', () => {
  assert.ok(!/^MemoryDenyWriteExecute=yes/m.test(script),
    'only the warning comment may mention it; never an active directive')
})

// ── secrets and platform guards ─────────────────────────────────────────────

test('the token and API key reach node through the environment, not argv', () => {
  // argv is world-readable via `ps`; this is the same exposure class as the
  // credential found in a process command line during the 2026-11 incident.
  assert.match(script, /NV_TOKEN="\$TOKEN"/)
  assert.ok(!/node -e .*\$TOKEN/.test(script), 'the token must never be interpolated into a node -e argument')
})

test('config.json is written 0600', () => {
  assert.match(script, /mode:\s*0o600/)
})

test('the install directory ends up owned by an unprivileged service user, mode 0700', () => {
  assert.match(script, /useradd --system/)
  assert.match(script, /chown -R "\$SVC_USER"/)
  assert.match(script, /chmod 700/)
  assert.match(script, /^User=\$SVC_USER$/m)
  assert.ok(!/^User=root$/m.test(script), 'the agent must not run as root')
})

test('the ddi module is refused rather than silently attempted', () => {
  // ddi is WinRM/DHCP-log/registry work. Accepting it on Linux would fail every
  // poll and report it as a collection fault instead of a wrong platform.
  assert.match(script, /slug === "ddi" \|\| slug === "ddivault"/)
  assert.match(script, /ignoring module/)
})

test('bundle paths from the manifest cannot escape the install directory', () => {
  // The manifest is trusted, but this runs as root — a traversal would write
  // anywhere on the filesystem.
  assert.match(script, /startsWith\("\/"\)/)
  assert.match(script, /includes\("\.\."\)/)
})

test('it refuses to run without a token, and without root', () => {
  assert.match(script, /An enrollment token is required/)
  assert.match(script, /must run as root/)
})

test('Node is required, not silently installed from a third-party repo', () => {
  assert.match(script, /Node\.js not found/)
  assert.match(script, /NODE_MAJOR/)
})

test('the hub is probed before anything on the host is changed', () => {
  const probeAt = script.indexOf('/api/health')
  const mutateAt = Math.min(
    ...[script.indexOf('useradd'), script.indexOf('mkdir -p'), script.indexOf('systemctl daemon-reload')]
      .filter((i) => i >= 0)
  )
  assert.ok(probeAt > 0 && probeAt < mutateAt,
    'the connectivity preflight must run before the first host mutation')
})
