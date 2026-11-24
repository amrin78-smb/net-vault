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
import { execFile, execSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { findGitRoot } from './gitRoot.ts'
import { LINE_RE, setEnvValue, type SetEnvResult } from './envFile.ts'
import { CONSOLES, type ConsoleSlug } from './consoles.ts'

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
/** The allow-list refusal, in one place so every write path shares it. */
export function assertManagedKey(key: string): void {
  if (!isManagedKey(key)) {
    throw new Error(`${key} is not a managed setting and may not be written from a request.`)
  }
}

export function resolveEnvTargets(key: string, cwd?: string): EnvTarget[] {
  assertManagedKey(key)
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

/**
 * The NSSM parameters key for one service.
 *
 * ⛔ ONE SPELLING. Two functions now query this key for two different values
 * (`AppEnvironmentExtra` for the pins, `AppDirectory` for the install root),
 * and a second literal would be a second place for a typo that always reads as
 * "we could not tell".
 */
export function serviceParamsKey(serviceName: string): string {
  return `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}\\Parameters`
}

export function serviceEnvPins(
  serviceName = 'NetVault',
  run: (cmd: string) => string = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 5000 }),
  platform: string = process.platform,
): string[] | null {
  if (platform !== 'win32') return null
  let out: string
  try {
    out = run(`reg query "${serviceParamsKey(serviceName)}" /v AppEnvironmentExtra`)
  } catch {
    // Absent value, absent service, or no permission. All three are "we cannot
    // tell", none of them is "nothing is pinned".
    return null
  }
  return parseServiceEnvKeys(out)
}

// ─── where a CONSOLE is installed ────────────────────────────────────────────

/**
 * The `AppDirectory` out of `reg query` output, or `null`.
 *
 * ⛔ A SEPARATE FUNCTION FROM `parseServiceEnvKeys`, AND IT MUST STAY SEPARATE.
 * That one deliberately throws every VALUE away, because the value it parses
 * (`AppEnvironmentExtra`) carries `NEXTAUTH_SECRET`, `DATABASE_URL` and
 * `NETVAULT_DB_PASS`. This one returns a value — a path — so if the two were
 * folded together there would be a single function that sometimes returns
 * values out of the string holding every secret the install has, and the next
 * person to need "just one more field" would widen it. Different value,
 * different function, no shared return type.
 *
 * ⛔ BOTH `REG_SZ` AND `REG_EXPAND_SZ` ARE ACCEPTED, AND NEITHER IS EXPANDED.
 * NSSM writes whichever the installer gave it, and an unexpanded
 * `%ProgramData%`-style path is still the honest answer: expanding it here
 * would mean resolving ANOTHER process's environment from this one, and a wrong
 * guess invents a directory. If the path cannot be used, the write against it
 * fails and says so — which is a reported failure rather than a setting written
 * somewhere nobody will look.
 */
export function parseServiceAppDirectory(regOutput: string): string | null {
  const m = /AppDirectory\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]*)/.exec(String(regOutput || ''))
  if (!m) return null
  const value = m[1].trim()
  return value === '' ? null : value
}

/**
 * Where a console service runs from, or `null` when that could not be read.
 *
 * ⛔ `null` IS NOT A PATH TO GUESS FROM, AND THIS IS THE WHOLE REASON THIS
 * FUNCTION EXISTS. Install paths are NOT uniform in this suite:
 * `C:\Apps\NetVault\app` and `C:\Apps\SpanVault\app`, but `C:\Apps\logvault`
 * and `C:\Apps\ddivault` with no `app` subfolder at all. A hub that
 * pattern-matched a path would write a console address into a directory that
 * does not exist on half the installs and report success. So the install root
 * is read from the service itself — the same reasoning as `Get-NssmForService`
 * in all four updaters, which locates nssm.exe from the service `ImagePath`
 * rather than from a guessed install layout.
 *
 * ⛔ AND A FAILED READ IS REPORTED AS A FAILED READ. Off Windows there is no
 * registry; without Administrator the query is refused; the service may not be
 * installed. All three are "we could not locate it", and the caller renders
 * that as "could not locate LogVault's environment files" — never as a clean
 * bill of health, and never as a fallback path.
 */
export function serviceAppDirectory(
  serviceName: string,
  run: (cmd: string) => string = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 5000 }),
  platform: string = process.platform,
): string | null {
  if (platform !== 'win32') return null
  let out: string
  try {
    out = run(`reg query "${serviceParamsKey(serviceName)}" /v AppDirectory`)
  } catch {
    // Absent value, absent service, or no permission. None of them is a path.
    return null
  }
  return parseServiceAppDirectory(out)
}

/**
 * Both registry facts about one console service, read ASYNCHRONOUSLY.
 *
 * ⛔ NO `execSync` ON A REQUEST PATH ([[sync-exec-blocks-event-loop]]). The
 * sync `serviceEnvPins`/`serviceAppDirectory` above are kept because
 * `writeManagedKey` and `shadowVerdict` are synchronous and off Windows they
 * never spawn anything at all — but the hub now needs these facts for FOUR
 * services, and four blocking `reg query` spawns in one handler is exactly the
 * shape that surfaces as database pool timeouts somewhere unrelated.
 *
 * ⛔ TWO `/v` QUERIES, NOT ONE KEY DUMP. A bare `reg query <key>` would print
 * every value including `AppEnvironmentExtra` — i.e. pull `NEXTAUTH_SECRET` and
 * `DATABASE_URL` into this process in a string that an error message could then
 * echo. Asking for each value by name keeps the secret-bearing one on the path
 * that is already careful with it (`parseServiceEnvKeys`, which returns key
 * names only).
 *
 * ⛔ EACH HALF FAILS INDEPENDENTLY TO `null`. "We could not read where LogVault
 * is installed" and "we could not read whether it pins this key" are different
 * facts with different consequences, and one of them failing must not be
 * reported as the other failing.
 */
export type ServiceValueReader = (serviceName: string, valueName: string) => Promise<string>

const execFileAsync = promisify(execFile)

export const regValueReader: ServiceValueReader = async (serviceName, valueName) => {
  const { stdout } = await execFileAsync(
    'reg',
    ['query', serviceParamsKey(serviceName), '/v', valueName],
    { timeout: 5000, encoding: 'utf8' },
  )
  return String(stdout)
}

export async function readServiceParams(
  serviceName: string,
  read: ServiceValueReader = regValueReader,
  platform: string = process.platform,
): Promise<{ pins: string[] | null; appDirectory: string | null }> {
  if (platform !== 'win32') return { pins: null, appDirectory: null }
  const one = async <T>(valueName: string, parse: (out: string) => T | null): Promise<T | null> => {
    try {
      return parse(await read(serviceName, valueName))
    } catch {
      return null
    }
  }
  const [pins, appDirectory] = await Promise.all([
    one('AppEnvironmentExtra', parseServiceEnvKeys),
    one('AppDirectory', parseServiceAppDirectory),
  ])
  return { pins, appDirectory }
}

/**
 * Path arithmetic on a path this process did not build.
 *
 * ⛔ `node:path` IS THE WRONG TOOL FOR A WINDOWS PATH READ ON LINUX. The
 * registry hands back `C:\Apps\logvault\frontend`, and `path.dirname` on a
 * POSIX host returns the whole string unchanged — so the deploy-source target
 * would silently become the running target and the two writes would both go to
 * the same file. The separator is taken from the value itself, the same way
 * `restartPaths` in lib/serviceRestart.ts does it.
 */
function sepOf(p: string): string {
  return p.includes('/') && !p.includes('\\') ? '/' : '\\'
}

function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir)
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

function parentPath(dir: string): string | null {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (cut <= 0) return null
  const parent = trimmed.slice(0, cut)
  // `C:` on its own is a drive, not a directory this feature should write into.
  return /^[A-Za-z]:$/.test(parent) ? null : parent
}

/**
 * The two files one SATELLITE console's `NEXTAUTH_URL` has to be written to.
 *
 * ⛔ DERIVED FROM `AppDirectory`, WHICH IS WHY IT WORKS ON BOTH INSTALL
 * LAYOUTS. The satellites' console service runs `next start` with
 * `AppDirectory = <root>\frontend`, and `next start` dotenv-loads from its own
 * cwd — so `<AppDirectory>\.env.local` is the RUNNING file and
 * `<parent(AppDirectory)>\.env.local` is the deploy-source. That derivation is
 * identical whether the root is `C:\Apps\SpanVault\app` or `C:\Apps\logvault`,
 * which is the entire point of reading the service instead of guessing a path.
 *
 * ⛔ THE DEPLOY SOURCE IS LOAD-BEARING, NOT A COURTESY. `Update-DDIVault.ps1`
 * copies the root `.env.local` over `frontend\.env.local` on EVERY run, so a
 * running-file-only write reverts at the next deploy with nothing reporting it
 * at the time it breaks. The satellites' Express API also dotenv-loads the ROOT
 * file (`spanvault/api/server.js`), so it is the file two processes read.
 *
 * ⛔ IT REFUSES THE HUB. NetVault's own `AppDirectory` is
 * `<root>\.next\standalone`, whose parent is `<root>\.next` — so this
 * derivation would write the hub's deploy source into its build output, which
 * `git clean` removes. The hub knows its own repo root (it is running from it)
 * and uses `resolveEnvTargets`; it does not need the registry to find itself.
 */
export function resolveConsoleEnvTargets(slug: ConsoleSlug, appDirectory: string): EnvTarget[] {
  if (CONSOLES[slug].isHub) {
    throw new Error(
      'The hub resolves its own environment files from its repo root (resolveEnvTargets); '
      + "deriving them from AppDirectory would put the deploy source inside .next. ",
    )
  }
  const dir = String(appDirectory || '').trim()
  if (!dir) throw new Error(`No AppDirectory was read for ${CONSOLES[slug].service}.`)
  const parent = parentPath(dir)
  if (!parent) {
    throw new Error(
      `${dir} has no parent directory, so ${CONSOLES[slug].label}'s deploy-source environment `
      + 'file cannot be located from it.',
    )
  }
  return [
    { path: joinPath(parent, '.env.local'), role: 'deploy-source', optionalIfMissing: false },
    { path: joinPath(dir, '.env.local'), role: 'running', optionalIfMissing: true },
  ]
}

// ─── the duplicate-key pre-flight ────────────────────────────────────────────

/**
 * Does this file carry the key more than once?
 *
 * ⛔ IT MATTERS WHICH COPY A LOADER HONOURS, AND HERE THE TWO READERS GENUINELY
 * DIFFER: dotenv reads the LAST occurrence and the updaters read the FIRST
 * (`Select-Object -First 1`). So a duplicated key makes the running value and
 * the next deployed value different by construction.
 */
export function duplicateIn(text: string, key: string): boolean {
  let count = 0
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = LINE_RE.exec(line)
    if (m && m[1] === key) count += 1
  }
  return count > 1
}

export type PreflightProblem =
  | { kind: 'unreadable'; path: string; message: string }
  | { kind: 'duplicate'; path: string; key: string }

/**
 * Run the duplicate/unreadable scan across EVERY target before the first write.
 *
 * ⛔ A REFUSAL MUST NOT LAND MID-SEQUENCE. `setEnvValue` refuses a duplicated
 * key — correctly — and this key goes to TWO files, so a duplicate in the
 * second one would refuse AFTER the first had been rewritten, leaving the
 * deploy source and the running file disagreeing about the address of a
 * console. Now that the hub writes four consoles, the same scan runs per app:
 * one satellite's duplicated key refuses THAT app and leaves the other three
 * (and the hub's own, already-landed write) alone.
 */
export function duplicateKeyPreflight(
  targets: EnvTarget[],
  key: string,
  io: { existsSync: (p: string) => boolean; readFileSync: (p: string) => string } = {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  },
): PreflightProblem | null {
  for (const t of targets) {
    if (!io.existsSync(t.path)) continue
    let text: string
    try {
      text = io.readFileSync(t.path)
    } catch (err: unknown) {
      return {
        kind: 'unreadable',
        path: t.path,
        message: err instanceof Error ? err.message : String(err),
      }
    }
    if (duplicateIn(text, key)) return { kind: 'duplicate', path: t.path, key }
  }
  return null
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
  opts: {
    cwd?: string
    serviceName?: string
    pins?: string[] | null
    /**
     * Where to write, when it is not this repo's own two files.
     *
     * ⛔ THE ALLOW-LIST STILL APPLIES. Explicit targets say WHERE, never WHAT:
     * `resolveEnvTargets` is still the thing that refuses an unmanaged key, and
     * it is called below for that refusal even when the targets come from the
     * caller. Otherwise passing targets would be a way to rewrite
     * `NEXTAUTH_SECRET` in a file of the caller's choosing from an HTTP route.
     *
     * Satellite targets come from `resolveConsoleEnvTargets`, which derives
     * them from the service's own `AppDirectory` rather than from any guessed
     * install path.
     */
    targets?: EnvTarget[]
  } = {},
): ManagedWriteResult {
  const serviceName = opts.serviceName || 'NetVault'
  // ⛔ THE ALLOW-LIST FIRST, FOR BOTH TARGET SOURCES. `resolveEnvTargets` is
  // what refuses an unmanaged key, so skipping it when the caller named the
  // targets would make explicit targets a way to rewrite NEXTAUTH_SECRET.
  const targets =
    opts.targets && opts.targets.length > 0
      ? (assertManagedKey(key), opts.targets)
      : resolveEnvTargets(key, opts.cwd)
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

// ─── the NSSM pin, when there is one ─────────────────────────────────────────
//
// ⛔ A PIN BEATS BOTH FILES, SO A PINNED CONSOLE CANNOT BE FIXED BY WRITING
// FILES. `AppEnvironmentExtra` is already in the environment when the Next
// server starts, and @next/env does not overwrite a variable that is already
// set — so on a pinned console the panel saved cleanly, the restart changed
// nothing, and nothing anywhere reported it. The files are still written (they
// are the durable record and the deploy source), and the pin is updated TOO.
//
// ⛔ ONLY WHEN THE KEY IS ALREADY PINNED. Appending a pin to a console that
// reads its value from a file would CREATE the shadowing problem — the suite's
// un-pin step (`Clear-NssmEnvKeys` in the updaters) exists to undo exactly
// that, and a settings page that re-added it would be fighting the updater.
//
// ⛔ AND IT IS A LINE-BY-LINE EDIT, DONE INSIDE POWERSHELL, FOR TWO REASONS.
// First: that string holds `NEXTAUTH_SECRET`, `DATABASE_URL` and
// `NETVAULT_DB_PASS`, so rebuilding it from a template would be the one bug
// that takes the whole suite down (every satellite verifies its SSO token
// against NEXTAUTH_SECRET). Second: doing the edit in the script means the
// VALUES NEVER ENTER THIS PROCESS AT ALL — they are read, edited and written
// back inside the registry-owning process, and nothing but a one-word verdict
// comes back over the pipe. No secret can reach a response body, a log line or
// a command line, because no secret is ever here.

/** What one pin update did. ⛔ A verdict, never a value. */
export type PinOutcome =
  /** The pin now carries the new value. */
  | 'ok'
  /** It already carried it. */
  | 'unchanged'
  /** This key is not pinned, so the files are what will be read. */
  | 'not-pinned'
  /** An entry could not be parsed as KEY=VALUE, so it was not round-tripped. */
  | 'unparsable'
  /** The write did not verify and the original was put back. */
  | 'restored'
  /** The write did not verify and could not be put back. */
  | 'damaged'
  /** The script could not be run, or said something this build does not know. */
  | 'unknown'

export const PIN_SENTINEL = '[NV-PIN]'

/**
 * The script that edits one pinned key.
 *
 * ⛔ IT PRINTS VERDICTS AND NOTHING ELSE. Every `Write-Output` below is one of
 * the tokens above; no branch echoes an entry, a value, or the whole array.
 * ⛔ IT VERIFIES ITSELF AND RESTORES ON ANY MISMATCH, exactly like
 * `setEnvValue` does for a file: read back, prove every OTHER entry is
 * byte-identical, and put the original back if not. A write that silently
 * dropped `NEXTAUTH_SECRET` from a service environment would not be noticed
 * until the next restart, by which point the original is gone.
 */
export function buildPinUpdateScript(opts: { serviceName: string; key: string; value: string }): string {
  const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`
  return [
    "$ErrorActionPreference = 'Stop'",
    `$svcKey = ${q(`HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${opts.serviceName}\\Parameters`)}`,
    `$name = ${q(opts.key)}`,
    `$new = ${q(opts.value)}`,
    'try {',
    '    $before = @((Get-ItemProperty -LiteralPath $svcKey -Name AppEnvironmentExtra -ErrorAction Stop).AppEnvironmentExtra)',
    `} catch { Write-Output '${PIN_SENTINEL} not-pinned'; exit 0 }`,
    `if ($before.Count -lt 1) { Write-Output '${PIN_SENTINEL} not-pinned'; exit 0 }`,
    '$idx = -1',
    'for ($i = 0; $i -lt $before.Count; $i++) {',
    '    $entry = [string]$before[$i]',
    '    $eq = $entry.IndexOf("=")',
    // ⛔ REFUSE, DO NOT GUESS. An entry that is not KEY=VALUE cannot be
    // round-tripped safely, and this array is the one holding every secret.
    `    if ($eq -lt 1) { Write-Output '${PIN_SENTINEL} unparsable'; exit 0 }`,
    '    if ($entry.Substring(0, $eq) -eq $name) { $idx = $i }',
    '}',
    `if ($idx -lt 0) { Write-Output '${PIN_SENTINEL} not-pinned'; exit 0 }`,
    `if ([string]$before[$idx] -eq ($name + "=" + $new)) { Write-Output '${PIN_SENTINEL} unchanged'; exit 0 }`,
    '$after = New-Object "System.Collections.Generic.List[string]"',
    'for ($i = 0; $i -lt $before.Count; $i++) {',
    '    if ($i -eq $idx) { $after.Add($name + "=" + $new) } else { $after.Add([string]$before[$i]) }',
    '}',
    '$afterArr = $after.ToArray()',
    'Set-ItemProperty -LiteralPath $svcKey -Name AppEnvironmentExtra -Value $afterArr -Type MultiString',
    '$check = @((Get-ItemProperty -LiteralPath $svcKey -Name AppEnvironmentExtra).AppEnvironmentExtra)',
    '$bad = $false',
    'if ($check.Count -ne $afterArr.Count) { $bad = $true }',
    'else { for ($i = 0; $i -lt $afterArr.Count; $i++) { if ([string]$check[$i] -ne [string]$afterArr[$i]) { $bad = $true } } }',
    'if ($bad) {',
    '    try {',
    '        Set-ItemProperty -LiteralPath $svcKey -Name AppEnvironmentExtra -Value $before -Type MultiString',
    `        Write-Output '${PIN_SENTINEL} restored'`,
    `    } catch { Write-Output '${PIN_SENTINEL} damaged' }`,
    '    exit 0',
    '}',
    `Write-Output '${PIN_SENTINEL} ok'`,
    '',
  ].join('\r\n')
}

/**
 * The script's verdict.
 *
 * ⛔ ANYTHING UNRECOGNISED IS `unknown`, WHICH THE CALLER RENDERS AS "still
 * shadowed" — never as success. A verdict this build cannot read is a read we
 * did not get.
 */
export function parsePinUpdateOutput(stdout: string | null | undefined): PinOutcome {
  const known: PinOutcome[] = ['ok', 'unchanged', 'not-pinned', 'unparsable', 'restored', 'damaged']
  let seen: PinOutcome = 'unknown'
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = new RegExp(`\\[NV-PIN\\]\\s+(\\S+)`).exec(line)
    if (!m) continue
    const token = m[1] as PinOutcome
    if (known.includes(token)) seen = token
  }
  return seen
}

export type PinRunner = (script: string) => Promise<string>

/**
 * Run a PowerShell script with the script itself on STDIN.
 *
 * ⛔ STDIN, NOT A COMMAND LINE. The script is the thing that touches the
 * secret-bearing array, and a command line is readable by every process on the
 * box; a pipe is not. (Nothing secret is interpolated into it either — the only
 * values are the service name, the key and the new console address — so this is
 * belt and braces, deliberately.)
 *
 * ⛔ NO `execSync` ON A REQUEST PATH ([[sync-exec-blocks-event-loop]]): a
 * synchronous child process in a handler blocks the event loop and surfaces as
 * database pool timeouts somewhere unrelated.
 */
export const powershellPinRunner: PinRunner = (script) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true },
    )
    let out = ''
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null
      child.kill()
      reject(new Error('the registry update timed out'))
    }, 20_000)
    const done = (fn: () => void) => {
      if (timer) { clearTimeout(timer); timer = null; fn() }
    }
    child.stdout?.on('data', (d) => { out += String(d) })
    child.stderr?.on('data', (d) => { out += String(d) })
    child.on('error', (err) => done(() => reject(err)))
    child.on('close', () => done(() => resolve(out)))
    child.stdin?.end(script)
  })

/**
 * Update one pinned key in one service environment.
 *
 * ⛔ PLATFORM-GATED LIKE THE READ. Off Windows there is nothing to write and
 * the answer is `unknown`, which keeps the console reported as shadowed rather
 * than as applied.
 */
export async function updateServiceEnvPin(
  serviceName: string,
  key: string,
  value: string,
  run: PinRunner = powershellPinRunner,
  platform: string = process.platform,
): Promise<PinOutcome> {
  assertManagedKey(key)
  if (platform !== 'win32') return 'unknown'
  try {
    return parsePinUpdateOutput(await run(buildPinUpdateScript({ serviceName, key, value })))
  } catch {
    // ⛔ The reason is deliberately not carried into the result: the only thing
    // a caller may do with this is report "the pin could not be updated", and
    // an error string from a process that just read a secret-bearing array is
    // not something to forward into a response body.
    return 'unknown'
  }
}

// ─── one console's write, start to finish ────────────────────────────────────

/**
 * How a single console's save came out.
 *
 * ⛔ FOUR STATES, AND `saved` IS THE ONLY ONE THAT MEANS THE CHANGE WILL BE
 * READ. Collapsing any of the other three into it is this suite's signature
 * bug — a failed read reported as a clean bill of health.
 *   - `saved`    — written, and nothing will shadow it after a restart.
 *   - `shadowed` — written, but the service environment pins the key and the
 *                  pin could not be updated, so a restart changes nothing.
 *   - `unknown`  — we could not locate that console's files, or could not read
 *                  whether its service environment pins the key. NOT "fine".
 *   - `failed`   — a definite refusal or a failed write, with the reason.
 */
export type ConsoleWriteState = 'saved' | 'shadowed' | 'unknown' | 'failed'

export type ConsoleWriteResult = {
  slug: ConsoleSlug
  label: string
  service: string
  publicPort: number
  state: ConsoleWriteState
  /** The address written, or `null` when nothing was written. */
  url: string | null
  appDirectory: string | null
  files: Array<{
    path: string
    role: EnvTarget['role']
    ok: boolean
    skipped: boolean
    unchanged: boolean | null
  }>
  shadow: ShadowVerdict
  /** `null` when no pin update was attempted (nothing is pinned, or nothing was written). */
  pin: PinOutcome | null
  takesEffectOnRestart: boolean | null
  /** The previous value in the deploy source, for putting it back by hand. */
  previous: string | null
  note: string | null
  error: string | null
  /** Which services have to restart for this console's change to take effect. */
  restartServices: string[]
}

export type ConsoleWriteDeps = {
  /** Where the console is installed. Defaults to the NSSM `AppDirectory` read. */
  locate?: (serviceName: string) => string | null
  /** Which keys its service environment pins. Defaults to `serviceEnvPins`. */
  readPins?: (serviceName: string) => string[] | null
  /** Updates an existing pin. Defaults to `updateServiceEnvPin`. */
  writePin?: (serviceName: string, key: string, value: string) => Promise<PinOutcome>
  /** Explicit targets — the hub passes its own; satellites derive theirs. */
  targets?: EnvTarget[]
  /** For the hub, the repo root to resolve its own two files from. */
  cwd?: string
}

/**
 * Write one managed key for one console: locate, pre-flight, write, re-pin.
 *
 * ⛔ IT IS ONE FUNCTION FOR ALL FOUR CONSOLES, INCLUDING THE HUB. Four copies
 * of "did this save actually take effect" would eventually disagree, and the
 * disagreement is a console nobody can sign in to. The only per-console
 * difference is where the two files are, and that difference is one `if`.
 *
 * ⛔ NO ROLLBACK, ACROSS FILES OR ACROSS CONSOLES — the same rule
 * `writeManagedKey` already documents. Each `setEnvValue` is individually
 * verified and self-restoring, so a failure leaves that FILE intact; undoing an
 * already-verified write to another product's deploy source because a later one
 * failed would mean touching a good secret-bearing file again for no safety
 * gain. The partial state is benign (durable, not yet live) and fully reported.
 */
export async function writeConsoleKey(
  slug: ConsoleSlug,
  key: string,
  value: string,
  deps: ConsoleWriteDeps = {},
): Promise<ConsoleWriteResult> {
  assertManagedKey(key)
  const facts = CONSOLES[slug]
  const locate = deps.locate || ((s: string) => serviceAppDirectory(s))
  const readPins = deps.readPins || ((s: string) => serviceEnvPins(s))
  const writePin = deps.writePin || ((s: string, k: string, v: string) => updateServiceEnvPin(s, k, v))

  const base: ConsoleWriteResult = {
    slug,
    label: facts.label,
    service: facts.service,
    publicPort: facts.publicPort,
    state: 'unknown',
    url: null,
    appDirectory: null,
    files: [],
    shadow: { state: 'unknown', reason: 'nothing was written, so nothing was measured' },
    pin: null,
    takesEffectOnRestart: null,
    previous: null,
    note: null,
    error: null,
    restartServices: [facts.service, ...facts.companionServices],
  }

  // ── where do its two files live?
  let targets: EnvTarget[]
  let appDirectory: string | null = null
  if (deps.targets && deps.targets.length > 0) {
    targets = deps.targets
  } else if (facts.isHub) {
    // The hub is running from its own repo; it does not need the registry to
    // find itself (and the satellite derivation is wrong for it — see
    // resolveConsoleEnvTargets).
    targets = resolveEnvTargets(key, deps.cwd)
  } else {
    appDirectory = locate(facts.service)
    if (appDirectory === null) {
      // ⛔ NEVER A GUESSED PATH. See `serviceAppDirectory`.
      return {
        ...base,
        state: 'unknown',
        note:
          `Could not locate ${facts.label}'s environment files: the ${facts.service} service's own `
          + 'install directory could not be read (this process may not be on the Windows host, may '
          + 'lack permission, or that service may not be installed). Nothing was written for '
          + `${facts.label}, and its address was NOT checked — this is an unknown, not a clean state.`,
      }
    }
    try {
      targets = resolveConsoleEnvTargets(slug, appDirectory)
    } catch (err: unknown) {
      return {
        ...base,
        appDirectory,
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // ── the pre-flight, before anything is written for this console
  const problem = duplicateKeyPreflight(targets, key)
  if (problem) {
    return {
      ...base,
      appDirectory,
      state: 'failed',
      error:
        problem.kind === 'duplicate'
          ? `${key} appears more than once in ${problem.path}, so a save there would have no `
            + 'reliable effect — dotenv reads the last occurrence and the updater reads the first. '
            + `Remove the duplicate line on the server first. Nothing was changed for ${facts.label}.`
          : `${problem.path} could not be read, so nothing was changed for ${facts.label} — a write `
            + 'against a file whose current contents are unknown is the one thing this is built to '
            + `prevent (${problem.message}).`,
    }
  }

  const pins = readPins(facts.service)
  const write = writeManagedKey(key, value, { serviceName: facts.service, pins, targets })
  const files = write.results.map((r) => ({
    path: r.path,
    role: r.role,
    ok: r.result === 'skipped-missing' ? true : r.result.ok,
    skipped: r.result === 'skipped-missing',
    unchanged: r.result !== 'skipped-missing' && r.result.ok ? r.result.unchanged : null,
  }))

  if (!write.ok) {
    return {
      ...base,
      appDirectory,
      state: 'failed',
      files,
      shadow: write.shadow,
      previous: write.previous,
      error: `${facts.label}'s console address could not be saved: ${write.error}`,
    }
  }

  // ── the pin, and ONLY when there already is one
  let pin: PinOutcome | null = null
  if (pins !== null && pins.includes(key)) {
    pin = await writePin(facts.service, key, value)
  }

  const common = {
    ...base,
    appDirectory,
    url: value,
    files,
    shadow: write.shadow,
    previous: write.previous,
    pin,
  }

  if (pins === null) {
    // ⛔ "WE DID NOT CHECK" IS NOT "NOTHING IS PINNED". If the service
    // environment does pin this key it wins over both files, so the restart
    // would change nothing — and that is the difference between a save that
    // works and one that does not.
    const reason = write.shadow.state === 'unknown' ? write.shadow.reason : 'the service environment could not be read'
    return {
      ...common,
      state: 'unknown',
      takesEffectOnRestart: null,
      note:
        `Saved to ${facts.label}'s environment files, but whether its ${facts.service} service `
        + `environment pins ${key} could not be determined (${reason}). If it does, it wins over both `
        + 'files and restarting will not apply this. An unchecked condition, not a clean bill of health.',
    }
  }

  if (pin !== null && pin !== 'ok' && pin !== 'unchanged' && pin !== 'not-pinned') {
    // ⛔ A PIN THAT EXISTS AND COULD NOT BE WRITTEN IS `shadowed`, NOT `saved`.
    return {
      ...common,
      state: 'shadowed',
      takesEffectOnRestart: false,
      note:
        `Saved to ${facts.label}'s environment files, but its ${facts.service} service environment `
        + `pins ${key} and a service environment variable wins over both files. The pin itself could `
        + `not be updated (${pin}), so restarting ${facts.service} will NOT change its address. `
        + (pin === 'damaged'
          ? 'The service environment may now be incomplete — check it on the server before restarting.'
          : 'Nothing else in that service environment was changed.'),
    }
  }

  return {
    ...common,
    state: 'saved',
    takesEffectOnRestart: true,
    note:
      pin === 'ok' || pin === 'unchanged'
        ? `Saved. ${facts.service}'s service environment pinned ${key} and that pin was updated too, `
          + 'so the restart applies it.'
        : null,
  }
}
