//
// lib/tlsTransport.ts — turning HTTPS on and off from Settings.
//
// `lib/tlsConfig.ts` answers "is this console encrypted right now". This module
// answers the next question: "can I CHANGE that from the panel, and what
// happened when I did". The work itself belongs to
// `installer/Enable-NocVaultTls.ps1` — three gates, a pre-cutover snapshot and
// an automatic revert, proven on production — so nothing here reimplements any
// of it. This module only decides what to run, and reads back what it did.
//
// ⛔ EVERY JUDGEMENT IN THIS FILE IS PURE AND LIVES OUTSIDE THE ROUTE, for the
// same reason `systemPanelHelpers.ts` exists: each one is a place where a
// three-state fact could be flattened to two, and the flattening is invisible
// in a screenshot. See `tests/tlsTransport.test.ts`.
//
// ⛔ AND THE BIG ONE: THE BANNER IS THE VERDICT, NOT THE EXIT CODE. MEASURED on
// production, twice, on 2026-11-06: `Enable-NocVaultTls.ps1` exited **0** on a
// run that moved all four consoles, failed gate 3, and reverted everything.
// Both the successful and the reverted run ended `exit: 0`. A panel that reads
// the exit code reports "HTTPS enabled" to an administrator whose suite is
// still on plain HTTP — which is the precise failure this whole feature exists
// to make impossible. The script's closing banner is unambiguous and is the
// only thing `parseRunLog` trusts for the verdict.

/** What the panel can ask for. */
export type TransportAction = 'preview' | 'enable' | 'disable'

export const TRANSPORT_ACTIONS: readonly TransportAction[] = ['preview', 'enable', 'disable']

export function isTransportAction(value: unknown): value is TransportAction {
  return typeof value === 'string' && (TRANSPORT_ACTIONS as readonly string[]).includes(value)
}

/**
 * The scheduled task the route creates, runs, and then has the wrapper delete.
 *
 * ⛔ ITS OWN NAME, NOT `NetVaultUpdate`. Reusing the updater's task would make a
 * cutover and an update able to overwrite each other's registration, and the
 * updater's task is one the INSTALLER registers permanently — deleting it as
 * cleanup would remove a scheduled job the install is supposed to keep.
 */
export const TRANSPORT_TASK_NAME = 'NocVault-TlsTransport'

/** The sentinel the wrapper writes last. Its presence means "the run ended". */
export const RUN_SENTINEL = '[NV-TRANSPORT] finished'

export type TransportPaths = {
  /** Everything the run printed, truncated at the start of each run. */
  log: string
  /** The running wrapper's PID, removed in its `finally`. */
  lock: string
  /** The wrapper the scheduled task actually executes. */
  wrapper: string
  /** The engine: installer\Enable-NocVaultTls.ps1. */
  script: string
}

/**
 * Where the run's files live.
 *
 * ⛔ UNDER THE REPO ROOT'S `logs`, which is where `Update-NetVault.ps1` and
 * `last-update-status` already look. A second convention for "where did the
 * last run write its output" is how a panel ends up reporting on a file nothing
 * writes.
 */
export function transportPaths(repoRoot: string): TransportPaths {
  const sep = repoRoot.includes('/') && !repoRoot.includes('\\') ? '/' : '\\'
  const join = (...parts: string[]) => parts.join(sep)
  return {
    log: join(repoRoot, 'logs', 'tls-transport.log'),
    lock: join(repoRoot, 'logs', 'tls-transport.lock'),
    wrapper: join(repoRoot, 'logs', 'tls-transport-run.ps1'),
    script: join(repoRoot, 'installer', 'Enable-NocVaultTls.ps1'),
  }
}

/**
 * A public hostname that is safe to put on a SYSTEM command line.
 *
 * ⛔ AN ALLOW-LIST, AND THE ONLY INPUT THIS FEATURE TAKES. The value is
 * interpolated into a PowerShell script that a scheduled task runs as SYSTEM,
 * so "validate it" is not tidiness — a character class wide enough to admit a
 * quote or a semicolon is remote code execution as SYSTEM, triggered from a
 * settings form. Labels are letters/digits/hyphens, no leading or trailing
 * hyphen, dot-separated, 253 characters total. Nothing else, ever.
 *
 * ⛔ AN IP ADDRESS IS REFUSED. Entra will not accept an IP in a Redirect URI
 * (confirmed against SecVault's field experience), so a hostname is the only
 * value that can be useful here — and silently accepting one that cannot work
 * is worse than refusing it.
 */
const HOSTNAME_LABEL = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/
const IPV4_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/

export type HostnameVerdict = { ok: true; host: string } | { ok: false; reason: string }

export function validatePublicHost(raw: unknown): HostnameVerdict {
  if (raw === null || raw === undefined || raw === '') return { ok: true, host: '' }
  if (typeof raw !== 'string') return { ok: false, reason: 'The public hostname must be text.' }
  const host = raw.trim()
  if (host === '') return { ok: true, host: '' }
  if (host.length > 253) return { ok: false, reason: 'A hostname cannot be longer than 253 characters.' }
  if (IPV4_SHAPE.test(host)) {
    return {
      ok: false,
      reason:
        'That is an IP address. Microsoft Entra refuses an IP address in a Redirect URI, so an IP '
        + 'here cannot be used for single sign-on — leave this blank to keep using the address the '
        + 'browser sends, or enter a hostname with a domain.',
    }
  }
  const labels = host.split('.')
  for (const label of labels) {
    if (label.length === 0 || label.length > 63 || !HOSTNAME_LABEL.test(label)) {
      return {
        ok: false,
        reason:
          'That is not a valid hostname. Use letters, digits and hyphens, separated by dots — for '
          + 'example console.example.com.',
      }
    }
  }
  return { ok: true, host }
}

/**
 * A PowerShell single-quoted literal.
 *
 * ⛔ BELT AND BRACES BEHIND `validatePublicHost`. The validator already makes a
 * quote impossible; this makes a validator that is ever loosened non-fatal,
 * because the quoting does not depend on the validator being right.
 */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The switches each action adds to the engine's command line. */
export function engineArgs(action: TransportAction, publicHost = ''): string[] {
  const args: string[] = []
  if (action === 'preview') args.push('-DryRun')
  if (action === 'disable') args.push('-Disable')
  // ⛔ NOT ON `disable`. Turning HTTPS off has no public host to set, and
  // passing one would be a parameter the operator never chose appearing on the
  // command line of the one action whose whole job is to undo.
  if (action !== 'disable' && publicHost) args.push('-TlsPublicHost', psLiteral(publicHost))
  return args
}

/**
 * The wrapper the scheduled task runs.
 *
 * ⛔ A WRAPPER FILE, NOT A LONGER `schtasks /tr`. The engine's output is the
 * only record of what happened, so it has to be captured — and capturing it
 * means a redirect, which means `cmd.exe /c "... > log 2>&1"` nested inside
 * `/tr "..."` inside the shell quoting of the `schtasks` call itself. Three
 * levels of quoting around a path with spaces is a defect waiting to happen,
 * and one that would only show up on a customer's install directory. A file on
 * disk has no quoting at all.
 *
 * ⛔ IT DELETES ITS OWN TASK. Otherwise every cutover leaves a scheduled task
 * behind on the customer's box, and the uninstaller grows another thing to
 * remember. It is removed last, after the sentinel is written, so a failure to
 * delete can never cost us the verdict.
 */
export function buildWrapperScript(opts: {
  script: string
  action: TransportAction
  log: string
  lock: string
  taskName: string
  publicHost?: string
}): string {
  const args = ['-File', psLiteral(opts.script), ...engineArgs(opts.action, opts.publicHost || '')]
  return [
    '# Generated by app/api/system/tls-transport. Overwritten on every run.',
    '$ErrorActionPreference = \'Continue\'',
    `$log  = ${psLiteral(opts.log)}`,
    `$lock = ${psLiteral(opts.lock)}`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null',
    '$PID | Out-File -FilePath $lock -Encoding ascii -Force',
    `"[NV-TRANSPORT] action=${opts.action} started $(Get-Date -Format s)" | Out-File -FilePath $log -Encoding UTF8 -Force`,
    'try {',
    `    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass ${args.join(' ')} 2>&1 |`,
    '        ForEach-Object { $s = "$_"; $s | Out-File -FilePath $log -Append -Encoding UTF8; $s }',
    '    $rc = $LASTEXITCODE',
    '} catch {',
    '    "[NV-TRANSPORT] wrapper error: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding UTF8',
    '    $rc = 1',
    '} finally {',
    // ⛔ The sentinel goes down BEFORE the cleanup. A panel polling this file
    // must learn the run ended even if removing the lock or the task throws.
    `    "${RUN_SENTINEL} exit=$rc action=${opts.action}" | Out-File -FilePath $log -Append -Encoding UTF8`,
    '    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue',
    `    & schtasks.exe /delete /tn ${psLiteral(opts.taskName)} /f 2>&1 | Out-Null`,
    '}',
    '',
  ].join('\r\n')
}

// ─── reading the run back ────────────────────────────────────────────────────

export type RunOutcome =
  /** No run has happened on this installation. */
  | 'none'
  /** Started and has not written its sentinel yet. */
  | 'running'
  /** `preview` completed and reported what it would do. */
  | 'previewed'
  /** HTTPS is on. */
  | 'enabled'
  /** HTTPS is off. */
  | 'disabled'
  /**
   * The engine refused or reverted. ⛔ A DISTINCT OUTCOME FROM `enabled`,
   * because the exit code is 0 for both.
   */
  | 'reverted'
  /** Ended without any banner we recognise. */
  | 'unknown'

export type RunReport = {
  outcome: RunOutcome
  action: TransportAction | null
  /** Reported for the record, never used to decide `outcome`. */
  exitCode: number | null
  finished: boolean
  /** The engine's own lines, newest last, for the panel to show verbatim. */
  lines: string[]
  /**
   * The gate/refusal lines worth putting in front of the operator without
   * making them read the whole log.
   */
  highlights: string[]
}

const BANNERS: Array<{ re: RegExp; outcome: RunOutcome }> = [
  // ⛔ ORDER MATTERS AND THE FAILURE COMES FIRST. "HTTPS was NOT enabled"
  // contains "HTTPS"; a looser match tested earlier would claim success on the
  // exact run that reverted.
  { re: /HTTPS was NOT enabled/i, outcome: 'reverted' },
  { re: /REVERTING the TLS cutover/i, outcome: 'reverted' },
  { re: /HTTPS is ON\b/i, outcome: 'enabled' },
  { re: /HTTPS is OFF\b/i, outcome: 'disabled' },
  { re: /Re-run without -DryRun/i, outcome: 'previewed' },
  { re: /Gates did NOT pass/i, outcome: 'reverted' },
]

/** Lines an operator should see first: gate results, refusals, probe verdicts. */
function isHighlight(line: string): boolean {
  return (
    /^\s*\[!!\]/.test(line)
    || /Gate \d(b)? (PASS|FAIL)/i.test(line)
    || /probe said/i.test(line)
    || /refus(e|ing)/i.test(line)
    || /TLS: not configured/i.test(line)
  )
}

/**
 * What the last run did.
 *
 * ⛔ `null` LOG IS `none`, AN UNREADABLE ONE IS NOT `none`. The caller passes
 * `null` only when the file genuinely does not exist; a read error is its own
 * problem and must not arrive here disguised as "no run has happened".
 */
export function parseRunLog(text: string | null | undefined): RunReport {
  if (text === null || text === undefined) {
    return { outcome: 'none', action: null, exitCode: null, finished: false, lines: [], highlights: [] }
  }
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l !== '')
  const sentinel = lines.find((l) => l.startsWith(RUN_SENTINEL)) || null
  const finished = sentinel !== null

  let action: TransportAction | null = null
  const actionLine = lines.find((l) => /\[NV-TRANSPORT\] action=/.test(l))
  const actionMatch = actionLine ? /action=([a-z]+)/.exec(actionLine) : null
  if (actionMatch && isTransportAction(actionMatch[1])) action = actionMatch[1]

  let exitCode: number | null = null
  if (sentinel) {
    const m = /exit=(-?\d+)/.exec(sentinel)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (Number.isFinite(n)) exitCode = n
    }
  }

  if (!finished) {
    return { outcome: 'running', action, exitCode: null, finished: false, lines, highlights: lines.filter(isHighlight) }
  }

  let outcome: RunOutcome = 'unknown'
  for (const banner of BANNERS) {
    if (lines.some((l) => banner.re.test(l))) {
      outcome = banner.outcome
      break
    }
  }
  return { outcome, action, exitCode, finished: true, lines, highlights: lines.filter(isHighlight) }
}

// ─── what the panel may offer ────────────────────────────────────────────────

export type TerminatorState = 'running' | 'stopped' | 'absent' | 'unknown'

export type TransportCapability = {
  canEnable: boolean
  canDisable: boolean
  canPreview: boolean
  /** Why an action is unavailable, for the panel to show instead of a dead button. */
  blockedReason: string | null
}

/**
 * Which actions make sense right now.
 *
 * ⛔ `unknown` BLOCKS BOTH DIRECTIONS. If we could not read whether the
 * terminator is running, we do not know which way the switch is facing — and
 * offering both buttons invites an operator to "turn on" a suite that is
 * already on, which moves four consoles for nothing.
 *
 * ⛔ AND NOT ON A NON-WINDOWS HOST. The engine is PowerShell driving NSSM; on
 * anything else the honest answer is that this panel cannot act, not a button
 * that fails when pressed.
 */
export function transportCapability(opts: {
  platform: string
  scriptPresent: boolean
  terminator: TerminatorState
  runInProgress: boolean
}): TransportCapability {
  const none = { canEnable: false, canDisable: false, canPreview: false }
  if (opts.platform !== 'win32') {
    return { ...none, blockedReason: 'Turning HTTPS on and off is only available on the Windows host that runs the suite services.' }
  }
  if (!opts.scriptPresent) {
    return {
      ...none,
      blockedReason:
        'installer\\Enable-NocVaultTls.ps1 is missing from this installation, so there is nothing to run. '
        + 'Ship the whole installer folder together.',
    }
  }
  if (opts.runInProgress) {
    return { ...none, blockedReason: 'A change is already running. Wait for it to finish.' }
  }
  if (opts.terminator === 'unknown') {
    return {
      ...none,
      blockedReason:
        'Whether the NocVault-Tls service is running could not be read, so which way this switch is '
        + 'facing is unknown. This is an unchecked condition, not a clean bill of health.',
    }
  }
  if (opts.terminator === 'running') {
    return { canEnable: false, canDisable: true, canPreview: true, blockedReason: null }
  }
  return { canEnable: true, canDisable: false, canPreview: true, blockedReason: null }
}

/**
 * The consoles this action is about to move, for the confirmation.
 *
 * ⛔ NAMED, NOT COUNTED. "This will move 4 consoles" is not something an
 * administrator can check against their own install; the ports are.
 */
export const SUITE_PUBLIC_PORTS: ReadonlyArray<{ app: string; port: number }> = [
  { app: 'NetVault', port: 3000 },
  { app: 'LogVault', port: 3004 },
  { app: 'DDIVault', port: 3006 },
  { app: 'SpanVault', port: 3008 },
]

/**
 * The URL the console moves to, so the panel can offer a link rather than
 * leaving the operator to guess.
 *
 * ⛔ THE BROWSER'S OWN HOST BY DEFAULT. `TLS_PUBLIC_HOST` is only an override;
 * when it is blank the terminator echoes the request's Host, so the address the
 * operator is already using is the address that keeps working.
 */
export function destinationUrl(opts: {
  action: TransportAction
  browserHost: string
  publicHost?: string
  port?: number
}): string | null {
  const host = (opts.publicHost || '').trim() || (opts.browserHost || '').trim()
  if (!host) return null
  const port = opts.port || 3000
  const scheme = opts.action === 'enable' ? 'https' : 'http'
  return `${scheme}://${host}:${port}/settings?tab=https`
}
