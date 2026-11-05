//
// lib/envTargets.ts — WHERE a managed setting has to be written, and whether
// writing it will actually take effect.
//
// SecVault has no equivalent of this file because SecVault has one env file and
// NSSM passes it only AppParameters. NetVault's same logical setting lives in
// THREE places, and getting this wrong is the difference between a Settings
// panel that works and one that reports success while changing nothing:
//
//   1. NSSM AppEnvironmentExtra        read at runtime, AND IT WINS OVER ANY
//                                      FILE. Set by Install-NocVault-Suite.ps1
//                                      on a fresh install, never removed.
//   2. <repo>/.env                     not read at runtime at all, but it is
//                                      the SOURCE Update-NetVault.ps1 copies
//                                      from on every deploy (its whitelist
//                                      includes NEXTAUTH_URL).
//   3. <repo>/.next/standalone/.env.local
//                                      what the running process actually reads,
//                                      for keys NSSM does not pin.
//
// ⛔ WHY ALL THREE MATTER, each on its own:
//   - write only (3) and the setting works until the next deploy, when the
//     updater copies (2) back over it. That is not hypothetical: SecVault's
//     console address reverted on deploy for exactly this reason, because its
//     installer read the FIRST duplicate key while dotenv read the LAST.
//   - write only (2) and nothing changes until someone deploys.
//   - leave (1) in place and NEITHER file is read, because dotenv does not
//     override a variable already present in process.env. The panel saves
//     cleanly, the restart changes nothing, and there is no error anywhere.
//
// So a managed key is written to (2) AND (3), and (1) is REPORTED — never
// silently worked around.

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { findGitRoot } from './gitRoot.ts'
import { setEnvValue, type SetEnvResult } from './envFile.ts'

/**
 * The keys this module is allowed to manage.
 *
 * ⛔ AN ALLOW-LIST, NOT AN ARBITRARY KEY. These writers run from an HTTP route;
 * the set of things a request may rewrite in the file holding NEXTAUTH_SECRET
 * and DATABASE_URL is decided here, in code, not by a request body. A key not
 * on this list is refused by resolveEnvTargets.
 */
export const MANAGED_KEYS = [
  'NEXTAUTH_URL',
  'TLS_CERT_PATH',
  'TLS_KEY_PATH',
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'ENTRA_CLIENT_SECRET',
] as const

export type ManagedKey = (typeof MANAGED_KEYS)[number]

export function isManagedKey(key: string): key is ManagedKey {
  return (MANAGED_KEYS as readonly string[]).includes(key)
}

/** The repo root, resolved the same way the update routes resolve it. */
export function repoRoot(cwd: string = process.cwd()): string {
  return findGitRoot(cwd)
}

export function rootEnvPath(cwd?: string): string {
  return path.join(repoRoot(cwd), '.env')
}

export function standaloneEnvPath(cwd?: string): string {
  return path.join(repoRoot(cwd), '.next', 'standalone', '.env.local')
}

export type EnvTarget = {
  path: string
  /** What this file is for, in words an operator can act on. */
  role: 'deploy-source' | 'running'
  /**
   * Whether the write may be skipped when the file is absent. The standalone
   * runtime file does not exist in a dev checkout that has never been built,
   * and refusing the whole save there would make the panel untestable off a
   * production box.
   */
  optionalIfMissing: boolean
}

/**
 * Every file one managed key must be written to, in order.
 *
 * ⛔ DEPLOY-SOURCE FIRST. If the second write fails, the value is already
 * durable and the next deploy completes the change; the reverse order leaves a
 * setting that works now and silently reverts later, which is strictly worse
 * because nothing reports it at the time it breaks.
 */
export function resolveEnvTargets(key: string, cwd?: string): EnvTarget[] {
  if (!isManagedKey(key)) {
    throw new Error(`${key} is not a managed setting and may not be written from a request.`)
  }
  return [
    { path: rootEnvPath(cwd), role: 'deploy-source', optionalIfMissing: false },
    { path: standaloneEnvPath(cwd), role: 'running', optionalIfMissing: true },
  ]
}

// ─── NSSM service environment ────────────────────────────────────────────────

/**
 * Which keys the NSSM service environment pins, or `null` when that could not
 * be determined.
 *
 * ⛔ KEYS ONLY — NEVER VALUES. AppEnvironmentExtra carries DATABASE_URL and
 * NEXTAUTH_SECRET. This function parses the key names and discards the rest
 * before returning, so a secret cannot reach a response body, a log line or an
 * error message by travelling inside this result.
 *
 * ⛔ `null` IS NOT AN EMPTY SET, and the distinction is the whole point. On the
 * Linux dev box there is no registry; without Administrator the query is
 * refused; the service may be named differently. Returning `[]` there would
 * read as "nothing is pinned, your write will take effect" — a failed read
 * recorded as an affirmative answer, which is this suite's signature bug. The
 * caller must render "could not check" differently from "clean".
 */
/**
 * Parse `reg query` output into the KEY NAMES it pins, or `null` when the
 * output carries no AppEnvironmentExtra value at all.
 *
 * ⛔ SEPARATE FROM THE PLATFORM GATE SO IT IS TESTABLE. Folded into
 * serviceEnvPins, this parser sat behind `if (process.platform !== 'win32')
 * return null` and could never be exercised on the Linux dev box or in CI —
 * a guard that cannot fire, over a parser whose failure mode is telling an
 * operator their write will take effect when it will not.
 */
export function parseServiceEnvKeys(regOutput: string): string[] | null {
  // REG_MULTI_SZ prints its entries separated by \0 on one line.
  const m = String(regOutput || '').match(/AppEnvironmentExtra\s+REG_\w+\s+([^\r\n]*)/)
  if (!m) return null
  const keys: string[] = []
  for (const entry of m[1].split(/\\0|\0/)) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const k = entry.slice(0, eq).trim()
    // ⛔ The key is pushed; m[1] and `entry` are discarded with the function.
    // Everything after the '=' is a VALUE, and AppEnvironmentExtra carries
    // DATABASE_URL and NEXTAUTH_SECRET. Nothing derived from it may escape.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) keys.push(k)
  }
  return keys
}

export function serviceEnvPins(
  serviceName = 'NetVault',
  run: (cmd: string) => string = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 5000 }),
  platform: string = process.platform,
): string[] | null {
  if (platform !== 'win32') return null
  let out: string
  try {
    out = run(
      `reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}\\Parameters" /v AppEnvironmentExtra`,
    )
  } catch {
    // Absent value, absent service, or no permission. All three are "we cannot
    // tell", none of them is "nothing is pinned".
    return null
  }
  return parseServiceEnvKeys(out)
}

export type ShadowVerdict =
  /** The service environment pins this key, so a file write cannot take effect. */
  | { state: 'shadowed'; serviceName: string }
  /** The service environment does not pin it; a file write will be read. */
  | { state: 'clear' }
  /** Could not be determined — rendered as such, never as 'clear'. */
  | { state: 'unknown'; reason: string }

export function shadowVerdict(
  key: string,
  serviceName = 'NetVault',
  pins: string[] | null = serviceEnvPins(serviceName),
): ShadowVerdict {
  if (pins === null) {
    return {
      state: 'unknown',
      reason:
        process.platform !== 'win32'
          ? 'not running on Windows, so the service environment could not be read here'
          : `the ${serviceName} service environment could not be read (the value may be absent, ` +
            'or this process may not have permission)',
    }
  }
  return pins.includes(key) ? { state: 'shadowed', serviceName } : { state: 'clear' }
}

// ─── the write ───────────────────────────────────────────────────────────────

export type ManagedWriteResult = {
  ok: boolean
  /** Per-file outcome, in the order written. */
  results: Array<{ path: string; role: EnvTarget['role']; result: SetEnvResult | 'skipped-missing' }>
  /** True when every non-skipped write succeeded. */
  error?: string
  /** Whether the running process will actually see this change after a restart. */
  shadow: ShadowVerdict
  previous: string | null
}

/**
 * Write one managed key everywhere it belongs.
 *
 * ⛔ IT DOES NOT ROLL BACK ACROSS FILES, AND THAT IS DELIBERATE. Each
 * setEnvValue is individually verified and self-restoring, so a failure leaves
 * that FILE intact. Undoing an already-successful write to the deploy source
 * because the runtime write failed would mean touching a verified-good secret
 * file a second time for no safety gain — and the partial state (durable but
 * not yet live) is benign and fully reported. The caller surfaces which files
 * landed.
 */
export function writeManagedKey(
  key: string,
  value: string | null,
  opts: { cwd?: string; serviceName?: string; pins?: string[] | null } = {},
): ManagedWriteResult {
  const serviceName = opts.serviceName || 'NetVault'
  const targets = resolveEnvTargets(key, opts.cwd)
  const results: ManagedWriteResult['results'] = []
  let previous: string | null = null
  let firstError: string | undefined

  for (const t of targets) {
    if (!fs.existsSync(t.path)) {
      if (t.optionalIfMissing) {
        results.push({ path: t.path, role: t.role, result: 'skipped-missing' })
        continue
      }
      const err = `${t.path} does not exist, so this setting has nowhere durable to live.`
      results.push({ path: t.path, role: t.role, result: { ok: false, error: err } })
      firstError = firstError || err
      continue
    }
    const r = setEnvValue(t.path, key, value)
    // The deploy source is the authoritative previous value — the runtime file
    // is a copy of it, so reporting the copy's previous value could name a
    // stale one if the two had drifted.
    if (t.role === 'deploy-source' && r.ok) previous = r.previous
    if (!r.ok) firstError = firstError || r.error
    results.push({ path: t.path, role: t.role, result: r })
  }

  return {
    ok: !firstError,
    results,
    error: firstError,
    // `undefined` falls through to shadowVerdict's own default (measure it);
    // an explicit `null` means the caller measured and could not tell.
    shadow: shadowVerdict(key, serviceName, opts.pins),
    previous,
  }
}
