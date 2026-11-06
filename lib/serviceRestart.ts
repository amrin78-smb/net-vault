//
// lib/serviceRestart.ts — restarting the hub from Settings.
//
// Several settings are durable the moment they are saved and INERT until the
// service restarts: NEXTAUTH_URL (NextAuth builds its options once at startup),
// the ENTRA_* values, and a replaced certificate. Until now the panel's honest
// answer was "restart the NetVault service", which is only actionable by
// someone with a console on the server — so a customer's own settings page
// could save a change it could not apply.
//
// ⛔ THE RESTART CANNOT BE AWAITED BY THE REQUEST THAT ASKS FOR IT. The service
// being restarted is the one serving the request; `sc.exe stop NetVault` kills
// the process mid-response. It is handed to a scheduled task running as SYSTEM
// — the same shape as `lib/tlsTransport.ts` and the in-app updater, for the
// same reason — and the panel watches for the console coming back.
//
// ⛔ THE SERVICE NAME IS A CONSTANT HERE, NEVER A REQUEST FIELD. A route that
// restarts whatever service a JSON body names is a denial-of-service primitive
// handed to anyone who reaches it; the only thing this feature needs to restart
// is the hub.

import { psLiteral } from './tlsTransport.ts'

/**
 * What the operator is trying to apply. ⛔ A PURPOSE, NEVER A SERVICE NAME FROM
 * A REQUEST: a route that restarts whatever service a JSON body names is a
 * denial-of-service primitive handed to anyone who reaches it.
 */
export type RestartPurpose = 'console-address' | 'certificate' | 'sso'

export const RESTART_PURPOSES: readonly RestartPurpose[] = ['console-address', 'certificate', 'sso']

export function isRestartPurpose(v: unknown): v is RestartPurpose {
  return typeof v === 'string' && (RESTART_PURPOSES as readonly string[]).includes(v)
}

/** The hub. Reads NEXTAUTH_URL and the ENTRA_* values once, at startup. */
export const HUB_SERVICE = 'NetVault'
/** The TLS front door. ⛔ THIS is the process that holds the certificate. */
export const TERMINATOR_SERVICE = 'NocVault-Tls'

export type RestartTarget =
  | { service: string; why: string }
  | { service: null; why: string }

/**
 * Which service has to restart for this change to take effect.
 *
 * ⛔ A CERTIFICATE IS NOT RESTARTED BY RESTARTING THE APP. NetVault's
 * standalone server never terminates TLS on this product — `NocVault-Tls`
 * does, and it reads the certificate at ITS startup. The Certificate panel
 * said "Restart the NetVault service to begin serving it", which is text from
 * before the terminator existed: following it restarts the wrong process, the
 * old certificate keeps being served, and the obvious conclusion is that the
 * install silently failed.
 *
 * CAUGHT when a real wildcard certificate was installed on production on
 * 2026-11-06 and the panel pointed at NetVault.
 *
 * ⛔ AND WITH NO TERMINATOR THERE IS NOTHING TO RESTART AT ALL. A certificate
 * on a suite serving plain HTTP changes nothing until HTTPS is turned on;
 * saying "restart X" there sends an operator to bounce a service for no
 * effect and conclude the certificate is broken.
 */
export function resolveRestartTarget(purpose: RestartPurpose, terminatorPresent: boolean): RestartTarget {
  if (purpose === 'certificate') {
    if (!terminatorPresent) {
      return {
        service: null,
        why:
          'HTTPS is not turned on, so nothing is serving this certificate yet and there is nothing to '
          + 'restart. Turn HTTPS on from Settings → HTTPS and the new certificate is used from the start.',
      }
    }
    return {
      service: TERMINATOR_SERVICE,
      why:
        `${TERMINATOR_SERVICE} is the process that terminates TLS and it reads the certificate when it `
        + 'starts. Restarting it serves the new certificate; the four consoles behind it are not restarted.',
    }
  }
  return {
    service: HUB_SERVICE,
    why:
      purpose === 'console-address'
        ? `NextAuth builds its options once at startup, so sign-in keeps using the old address until ${HUB_SERVICE} restarts.`
        : `The directory settings are read once at startup, so single sign-on keeps using the old values until ${HUB_SERVICE} restarts.`,
  }
}

/** Kept for callers that only ever meant the hub. */
export const RESTART_SERVICE = HUB_SERVICE

/** Deleted by the wrapper at the end of a run, so it is normally absent. */
export const RESTART_TASK_NAME = 'NocVault-ServiceRestart'

export const RESTART_SENTINEL = '[NV-RESTART] finished'

export type RestartPaths = { log: string; lock: string; wrapper: string }

export function restartPaths(repoRoot: string): RestartPaths {
  const sep = repoRoot.includes('/') && !repoRoot.includes('\\') ? '/' : '\\'
  const join = (...parts: string[]) => parts.join(sep)
  return {
    log: join(repoRoot, 'logs', 'service-restart.log'),
    lock: join(repoRoot, 'logs', 'service-restart.lock'),
    wrapper: join(repoRoot, 'logs', 'service-restart-run.ps1'),
  }
}

/**
 * The wrapper the scheduled task runs.
 *
 * ⛔ IT POLLS FOR `STOPPED` RATHER THAN SLEEPING. MEASURED on production:
 * LogVault-App reaches STOPPED in 517 ms but does not report RUNNING for
 * ~20 s (NSSM's start throttle), so neither a fixed sleep nor a RUNNING check
 * describes "is it back". `sc.exe start` issued while a service is still
 * STOP_PENDING is REJECTED, and the old code in the cutover ignored that
 * return — the same defect this file must not repeat.
 *
 * ⛔ AND IT STARTS THE SERVICE EVEN IF THE STOP TIMED OUT. The one thing worse
 * than a slow restart is a stop with no start after it: that is the hub left
 * down by a settings page.
 */
export function buildRestartWrapper(opts: {
  service: string
  log: string
  lock: string
  taskName: string
  /**
   * Services that DEPEND ON `service` and must be stopped before it, then
   * started again after.
   *
   * ⛔ WITHOUT THIS THE HUB RESTART IS A NO-OP THAT REPORTS SUCCESS.
   * `NocVault-Tls` declares `DependOnService NetVault`, so Windows REFUSES
   * `sc stop NetVault` with 1051 (ERROR_DEPENDENT_SERVICES_RUNNING) while the
   * terminator is running. The stop fails, the following `sc start` returns
   * 1056 (already running), the service is still Running — and a verdict based
   * on "is it running" reads all of that as a successful restart while the old
   * process, with the old NEXTAUTH_URL, never went anywhere.
   */
  dependents?: string[]
}): string {
  const svc = psLiteral(opts.service)
  const deps = (opts.dependents || []).filter((d) => d && d !== opts.service)
  const depsLiteral = deps.length ? `@(${deps.map(psLiteral).join(', ')})` : '@()'
  return [
    '# Generated by app/api/system/service-restart. Overwritten on every run.',
    "$ErrorActionPreference = 'Continue'",
    `$log  = ${psLiteral(opts.log)}`,
    `$lock = ${psLiteral(opts.lock)}`,
    `$svc  = ${svc}`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null',
    '$PID | Out-File -FilePath $lock -Encoding ascii -Force',
    // ⛔ APPEND, NOT -Force. The ROUTE truncates this log and writes the
    // `runId=` header before scheduling the task, so the panel can tell ITS
    // run's verdict from the previous run's. If the wrapper truncated here,
    // there would be a window — task scheduled, wrapper not yet started — in
    // which the log still holds the PREVIOUS run's verdict, and the panel
    // would present it as this run's result.
    '"[NV-RESTART] service=$svc started $(Get-Date -Format s)" | Out-File -FilePath $log -Append -Encoding UTF8',
    `$deps = ${depsLiteral}`,
    '$rc = 1',
    // ⛔ THE PID, NOT "IS IT RUNNING". A service that never stopped is still
    // Running, and that is exactly what a refused stop leaves behind. The only
    // evidence a restart happened is a DIFFERENT process.
    '$before = (Get-CimInstance Win32_Service -Filter "Name=\'$svc\'" -ErrorAction SilentlyContinue).ProcessId',
    '"[NV-RESTART] pid before: $before" | Out-File -FilePath $log -Append -Encoding UTF8',
    'try {',
    '    foreach ($d in $deps) {',
    '        $ds = (Get-Service -Name $d -ErrorAction SilentlyContinue)',
    '        if ($ds -and $ds.Status -ne \'Stopped\') {',
    '            $o = (& sc.exe stop $d 2>&1 | Out-String).Trim()',
    '            "[NV-RESTART] dependent $d stop: $($o -replace \'\\s+\', \' \')" | Out-File -FilePath $log -Append -Encoding UTF8',
    '            $dw = [Diagnostics.Stopwatch]::StartNew()',
    '            while ($dw.Elapsed.TotalSeconds -lt 45 -and (Get-Service -Name $d -ErrorAction SilentlyContinue).Status -ne \'Stopped\') { Start-Sleep -Milliseconds 250 }',
    '        }',
    '    }',
    '    $stopOut = (& sc.exe stop $svc 2>&1 | Out-String).Trim()',
    '    "[NV-RESTART] stop issued: $($stopOut -replace \'\\s+\', \' \')" | Out-File -FilePath $log -Append -Encoding UTF8',
    '    $sw = [Diagnostics.Stopwatch]::StartNew()',
    '    while ($sw.Elapsed.TotalSeconds -lt 60) {',
    '        if ((Get-Service -Name $svc -ErrorAction SilentlyContinue).Status -eq \'Stopped\') { break }',
    '        Start-Sleep -Milliseconds 250',
    '    }',
    '    $state = (Get-Service -Name $svc -ErrorAction SilentlyContinue).Status',
    '    "[NV-RESTART] state after $([int]$sw.ElapsedMilliseconds) ms: $state" | Out-File -FilePath $log -Append -Encoding UTF8',
    // ⛔ UNCONDITIONAL **AND RETRIED**, and the retry is the load-bearing half.
    // The stop poll above exits either because the service reached Stopped or
    // because it timed out — and the only way it times out is the service
    // still being STOP_PENDING, which is precisely the state in which
    // `sc start` is rejected (1056/1061). A single start issued at that
    // moment is guaranteed to be refused, and the old code then only
    // OBSERVED Status for 120 s without ever asking again: the service
    // finished stopping a few seconds later and stayed Stopped forever.
    // That is the console left down by a settings page — the one outcome
    // this function's header calls worse than a slow restart.
    '    $running = $false',
    '    $sw2 = [Diagnostics.Stopwatch]::StartNew()',
    '    $attempt = 0',
    '    while ($sw2.Elapsed.TotalSeconds -lt 150) {',
    '        $st = (Get-Service -Name $svc -ErrorAction SilentlyContinue).Status',
    '        if ($st -eq \'Running\') { $running = $true; break }',
    // Never fire into a pending transition: that is the rejection above.
    '        if ($st -ne \'StartPending\' -and $st -ne \'StopPending\') {',
    '            $attempt = $attempt + 1',
    '            $startOut = (& sc.exe start $svc 2>&1 | Out-String).Trim()',
    '            "[NV-RESTART] start attempt $attempt : $($startOut -replace \'\\s+\', \' \')" | Out-File -FilePath $log -Append -Encoding UTF8',
    '        }',
    '        Start-Sleep -Milliseconds 1000',
    '    }',
    // The dependents go back up LAST, and whether they do is part of the
    // verdict: a terminator left stopped means four consoles unreachable.
    '    $depsBack = $true',
    '    foreach ($d in $deps) {',
    '        $null = & sc.exe start $d 2>&1',
    '        $dw2 = [Diagnostics.Stopwatch]::StartNew()',
    '        $ok = $false',
    '        while ($dw2.Elapsed.TotalSeconds -lt 90) {',
    '            if ((Get-Service -Name $d -ErrorAction SilentlyContinue).Status -eq \'Running\') { $ok = $true; break }',
    '            Start-Sleep -Milliseconds 500',
    '        }',
    '        if (-not $ok) { $depsBack = $false }',
    '        "[NV-RESTART] dependent $d back: $ok" | Out-File -FilePath $log -Append -Encoding UTF8',
    '    }',
    '    $after = (Get-CimInstance Win32_Service -Filter "Name=\'$svc\'" -ErrorAction SilentlyContinue).ProcessId',
    '    $changed = ($before -ne $after)',
    '    "[NV-RESTART] pid after: $after changed=$changed" | Out-File -FilePath $log -Append -Encoding UTF8',
    '    "[NV-RESTART] running=$running after $([int]$sw2.ElapsedMilliseconds) ms" | Out-File -FilePath $log -Append -Encoding UTF8',
    '    $rc = if ($running -and $changed -and $depsBack) { 0 } else { 1 }',
    '} catch {',
    '    "[NV-RESTART] wrapper error: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding UTF8',
    '    $rc = 1',
    '} finally {',
    `    "${RESTART_SENTINEL} exit=$rc" | Out-File -FilePath $log -Append -Encoding UTF8`,
    '    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue',
    `    & schtasks.exe /delete /tn ${psLiteral(opts.taskName)} /f 2>&1 | Out-Null`,
    '}',
    '',
  ].join('\r\n')
}

export type RestartOutcome = 'none' | 'running' | 'succeeded' | 'failed'

export type RestartReport = {
  outcome: RestartOutcome
  finished: boolean
  lines: string[]
  /** Which run this log belongs to, so a panel never reads a stale verdict. */
  runId: string | null
}

/**
 * What the last restart did.
 *
 * ⛔ `running=True` IS THE VERDICT, NOT THE EXIT CODE — same rule as
 * `lib/tlsTransport.ts`, and for the same reason: on this codebase a
 * PowerShell exit code is evidence of nothing. The wrapper writes whether the
 * service actually came back, and that line is what is read.
 */
/** The header the ROUTE writes before scheduling, stamping this run's id. */
export const RESTART_RUN_PREFIX = '[NV-RESTART] runId='

export function buildRestartHeader(runId: string, service: string): string {
  return `${RESTART_RUN_PREFIX}${runId} service=${service}\r\n`
}

export function parseRestartLog(text: string | null | undefined): RestartReport {
  if (text === null || text === undefined) return { outcome: 'none', finished: false, lines: [], runId: null }
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l !== '')
  const finished = lines.some((l) => l.startsWith(RESTART_SENTINEL))
  const idLine = lines.find((l) => l.startsWith(RESTART_RUN_PREFIX))
  const runId = idLine ? (idLine.slice(RESTART_RUN_PREFIX.length).split(/\s+/)[0] || null) : null
  if (!finished) return { outcome: 'running', finished: false, lines, runId }
  // ⛔ BOTH, AND `changed` IS THE LOAD-BEARING HALF. A refused stop (1051,
  // dependent service running) leaves the service Running the whole time, so
  // `running=True` alone is exactly what a restart that never happened looks
  // like. A different PID is the only proof the process was replaced.
  const ran = lines.some((l) => /\[NV-RESTART\] running=True/i.test(l))
  const changed = lines.some((l) => /\[NV-RESTART\] pid after: .*changed=True/i.test(l))
  // ⛔ AND THE DEPENDENTS HAVE TO BE BACK. The wrapper already makes `$depsBack`
  // a third term of its exit code — and this function deliberately ignores exit
  // codes, so that term was being written into a value nothing read. The log
  // line is right there. Without this, "the hub restarted cleanly but
  // NocVault-Tls never came back" reported `succeeded` while all four consoles'
  // public ports were dead — a false all-clear from the one function whose
  // entire job is to refuse them.
  const depsFailed = lines.some((l) => /\[NV-RESTART\] dependent .* back: False/i.test(l))
  return { outcome: ran && changed && !depsFailed ? 'succeeded' : 'failed', finished: true, lines, runId }
}
