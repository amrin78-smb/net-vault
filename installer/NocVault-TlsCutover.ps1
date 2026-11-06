#
# installer\NocVault-TlsCutover.ps1 — the shared TLS terminator cutover.
#
# ⛔ THIS FILE IS DOT-SOURCED, NOT RUN. It has no param() block and defines no
# function: it executes in the CALLER'S SCOPE and reads the caller's variables
# directly. That is the whole reason it can be shared without being rewritten —
# the body below is byte-for-byte the code that was proven on real Windows
# during the staging dry run, moved rather than retyped.
#
# Two callers:
#   Install-NocVault-Suite.ps1   a fresh install, after STEP 12
#   Enable-NocVaultTls.ps1       an installation that already exists
#
# ⛔ THE CALLER MUST SET ALL OF THESE FIRST. Dot-sourcing gives no signature to
# check against, so a missing one is a $null that behaves like a decision:
#
#   $TlsGateOk            $true only if gates 1 and 2 passed (cert + Node)
#   $TlsGateReason        why not, when $TlsGateOk is $false
#   $NssmExe              path to nssm.exe
#   $NVDir $NVAppDir      NetVault install root and repo root
#   $LVAppDir $DDIAppDir $SVAppDir
#   $InstallLogVault $InstallDDIVault $InstallSpanVault
#   $ServerIP             the address the consoles were installed on
#   $TlsPublicHostValue   the hostname to pin, or '' to use $ServerIP
#   $NVEnvTail            the TLS_* lines appended to NetVault's .env
#   $CronSecret           for the post-cutover health-snapshot call
#   $OpenHttpRedirectPorts
#
# It sets $script:TlsCutoverApplied for the caller to read afterwards.
#

# ================================================================
# STEP 12.5 — Shared TLS terminator + loopback cutover (GATE 3)
# ================================================================
# ⛔ THE ORDER OF THIS STEP IS THE ENTIRE SAFETY ARGUMENT. DO NOT REARRANGE IT,
# AND DO NOT "SIMPLIFY" THE REVERT AWAY.
#
# Everything above this line has already produced a working, fully verified
# plain-HTTP suite on 0.0.0.0. This step is the ONLY place that changes that,
# and it is written as one transaction with exactly two outcomes:
#
#   commit  - all four consoles bound to 127.0.0.1:1300X, NocVault-Tls serving
#             HTTPS on 3000/3004/3006/3008, PROVEN by a real HTTPS GET of each
#             console's /api/health through the terminator.
#   revert  - every console back on 0.0.0.0:300X, NEXTAUTH_URL back to http://,
#             the suite probe URLs back as they were, NocVault-Tls removed
#             entirely. Identical to never having run this step.
#
# It CANNOT half-apply, and the reason is structural rather than careful:
#   * one function (Set-ConsoleTransport) performs BOTH halves - the loopback
#     bind AND the https:// NEXTAUTH_URL - per console, so a scheme mismatch
#     (which bounces every sign-in silently, with no error in any log) cannot
#     be produced by a partial run;
#   * one function (Restore-ConsoleTransport) undoes both from a snapshot taken
#     before anything was touched, and it is called from EVERY failure path -
#     a console that would not restart, a terminator that would not start, a
#     missing HTTPS 200, the banner;
#   * the terminator cannot be left behind by a revert, because the revert
#     stops AND removes the service. A leftover auto-start NocVault-Tls would
#     fight the apps for port 3000 on the next reboot.
#
# ⛔ WHY THE CONSOLES MOVE FIRST AND ARE PROVEN SECOND, RATHER THAN THE REVERSE.
# It would be safer still to prove the terminator before moving anything, and
# it is not possible: the terminator's public ports ARE 3000/3004/3006/3008,
# the ports the four consoles are holding right now. Something has to let go
# first. So the move is made reversible instead of avoidable, and the window in
# which the consoles are not externally reachable is bounded by the health
# polls below - on a fresh install, before any user exists.
#
# ⛔ GATE 3 IS AN HTTPS REQUEST THAT RETURNS 200, NOT "the service says Running".
# NSSM reports Running for a process that bound nothing (start.mjs's own header
# records that exact failure), and the terminator deliberately degrades a broken
# certificate to plain HTTP rather than refusing to start - which would leave
# the consoles reachable but UNENCRYPTED while every check that only looks at
# service state passes. Only bytes off the socket settle it.
#
# Set once, here, and written ONLY on the commit path. STEP 13 and the closing
# summary read it to decide what to verify and which URL scheme to print, so a
# default of $false is what keeps a reverted run from advertising HTTPS.
$script:TlsCutoverApplied = $false

if (-not $TlsGateOk) {
    Write-Step "Shared TLS terminator"
    Write-Info "Not installed. $TlsGateReason"
    Write-Info "Consoles remain on 0.0.0.0:3000/3004/3006/3008 (plain HTTP), NEXTAUTH_URL stays http:// - the shipping configuration."
} else {
    Write-Step "Shared TLS terminator (NocVault-Tls)"

    # ⛔ THIS BLOCK EXISTS BECAUSE THE EXTRACTION MISSED A DEPENDENCY.
    # The cutover re-registers NetVault's three scheduled tasks against the
    # hub's loopback port, and it did so by calling Register-MaintenanceTask -
    # a function defined in Install-NocVault-Suite.ps1 and therefore present
    # only when the INSTALLER dot-sources this file. Run from
    # Enable-NocVaultTls.ps1 it is not defined, and PowerShell's answer to an
    # unknown command is a non-terminating error: three of them, followed by
    # this file's own unconditional "[OK] NetVault cron tasks re-pointed".
    #
    # The consequence was silent and delayed, which is the worst combination:
    # the three tasks keep posting to http://127.0.0.1:3000, which after a
    # cutover is the TERMINATOR speaking TLS. The nightly health snapshot, the
    # daily EOL enrichment and the weekly feed sync all stop - no error
    # anywhere, just a trend chart that never gains a point, which is the exact
    # failure the comment beside that code warns about.
    #
    # Caught on the staging lab, by reading the output of a cutover that had
    # otherwise succeeded. Defined only when absent, so the installer's own
    # copy still wins inside the installer.
    if (-not (Get-Command Register-MaintenanceTask -ErrorAction SilentlyContinue)) {
        function Register-MaintenanceTask([string]$Name, $Action, $Trigger, [string]$When) {
            try {
                $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
                Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Principal $principal -Force | Out-Null
                Write-OK "Scheduled task '$Name' registered ($When)"
            } catch {
                Write-Warn "Could not register scheduled task '$Name' ($When) - non-fatal: $($_.Exception.Message)"
            }
        }
    }

    # ---- helpers (local to this step) -----------------------------------
    # nssm emits UTF-16 and the NULs survive the capture; '' means "could not
    # read", which every caller treats as a reason not to proceed.
    function Get-NssmSetting([string]$nssmExe, [string]$service, [string]$setting) {
        $ErrorActionPreference = 'Continue'
        $raw = ''
        try { $raw = (& $nssmExe get $service $setting 2>&1 | Out-String) } catch { $raw = '' }
        $raw = $raw -replace "`0", ''
        return $raw.Trim()
    }

    # Rewrite one KEY=VALUE in place, leaving every other line untouched.
    # Reads RAW and splits on \r?\n itself: this installer writes these files
    # LF-only, but Settings and any later Add-Content write CRLF, and an
    # anchored regex tested against a line still carrying its trailing \r
    # silently stops matching.
    function Set-EnvFileKey([string]$path, [string]$key, [string]$value) {
        if (-not (Test-Path -LiteralPath $path)) { return $false }
        $raw = ''
        try { $raw = (Get-Content -LiteralPath $path -Raw -ErrorAction Stop) } catch { return $false }
        if ($null -eq $raw) { $raw = '' }
        $lines = @($raw -split "`r?`n")
        $found = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^\s*' + [regex]::Escape($key) + '\s*=')) {
                $lines[$i] = "$key=$value"
                $found = $true
            }
        }
        if (-not $found) { $lines = @($lines) + "$key=$value" }
        try { ($lines -join "`n") | Out-File -FilePath $path -Encoding UTF8 -NoNewline } catch { return $false }
        return $true
    }

    function Restart-NocService([string]$service) {
        $ErrorActionPreference = 'Continue'
        $null = & sc.exe stop $service 2>&1
        Start-Sleep -Seconds 4
        $null = & sc.exe start $service 2>&1
        # 1056 = ERROR_SERVICE_ALREADY_RUNNING. NSSM's AppRestartDelay can have
        # relaunched the child already; the health poll is the real verdict, so
        # this is not treated as a failure (same reasoning as Update-NetVault.ps1).
        return $true
    }

    # ⛔ WHY THE LAST POLL FAILED, KEPT. This used to be `catch {}` - every
    # attempt's reason discarded - and the gate reported only "did NOT answer".
    # That one missing string cost two production evenings and five disproved
    # hypotheses: the console was healthy every time (HTTP 200 to the very next
    # request from the diagnostics block), so the fault was always in the probe
    # or in what the probe could not see, and nothing recorded which.
    $script:LastProbeSummary = ''

    function Wait-HttpOk([string]$url, [int]$timeoutSec) {
        $script:LastProbeSummary = ''
        $tally    = @{}
        $attempts = 0
        $deadline = (Get-Date).AddSeconds($timeoutSec)
        # ⛔ A DEADLINE, NOT AN ITERATION COUNT. `for ($i -lt $timeoutSec)` with
        # a 1 s sleep and a 3 s per-attempt cap meant "90" could mean anything
        # from 90 to 360 seconds, so the one number a reader could check was the
        # one number that was not true.
        while ((Get-Date) -lt $deadline) {
            $attempts++
            $reason = ''
            try {
                # ⛔ HttpWebRequest, NOT Invoke-WebRequest. Wait-HttpsOk's header
                # records the measurement that forced this same choice for the
                # HTTPS probe on this very suite: same server, same moment,
                # Invoke-WebRequest failed where HttpWebRequest returned 200.
                # Leaving the plain-HTTP probe on the client that was already
                # measured to be the unreliable one was an inconsistency with
                # nothing behind it.
                $req = [System.Net.HttpWebRequest]::Create($url)
                # 20 s, not 3. MEASURED on production: logvault's /api/health is
                # a middleware REWRITE to the Express API on :3005, so it pays an
                # extra internal hop and answers in 1.2-1.9 s where the other
                # three answer in ~0.1 s. A 3 s cap left it 2x headroom while the
                # others had 30x - a gate far tighter for one console than the
                # rest, for no stated reason.
                $req.Timeout          = 20000
                $req.ReadWriteTimeout = 20000
                $req.Method           = 'GET'
                # A loopback probe must never be routed through a system proxy.
                # WinINET's bypass list is somebody else's configuration and this
                # request's destination is this machine.
                $req.Proxy            = $null
                $resp = $req.GetResponse()
                $code = [int]$resp.StatusCode
                $resp.Close()
                if ($code -eq 200) { return $true }
                $reason = "HTTP $code"
            } catch {
                $reason = $_.Exception.Message
                if (-not $reason) { $reason = $_.Exception.GetType().FullName }
            }
            if (-not $tally.ContainsKey($reason)) { $tally[$reason] = 0 }
            $tally[$reason] = $tally[$reason] + 1
            Start-Sleep -Seconds 1
        }
        $parts = @()
        foreach ($k in ($tally.Keys | Sort-Object { $tally[$_] } -Descending)) {
            $parts += ("{0}x {1}" -f $tally[$k], $k)
        }
        $script:LastProbeSummary = "$attempts attempt(s) over ${timeoutSec}s: " + ($parts -join ' | ')
        return $false
    }

    # ⛔ TLS 1.2 IS STATED EXPLICITLY AND THE CERTIFICATE IS DELIBERATELY NOT
    # VALIDATED - both halves are load-bearing.
    #
    # Windows PowerShell 5.1 is .NET Framework, where ServicePointManager
    # defaults to SSL3|TLS1.0. The terminator sets minVersion: 'TLSv1.2', so the
    # handshake fails against a listener that is working perfectly, gate 3 reads
    # that as "no HTTPS" and the whole cutover reverts for no reason. This is the
    # same trap already documented on Update-NetVault.ps1's agent-ingest probe,
    # where the default protocols produced "A call to SSPI failed" and the script
    # concluded the listener was plaintext.
    #
    # Validation is skipped because the question is "is the terminator
    # terminating TLS and is the console behind it answering", not "does this
    # chain to a root this box trusts". The probe dials 127.0.0.1, which no
    # customer certificate will ever name, so a validating probe could only
    # fail. The global callback is saved and restored in finally - it is
    # process-wide state and leaving it permissive would silently weaken every
    # later HTTPS request in this script.
    function Wait-HttpsOk([string]$url, [int]$timeoutSec) {
        $prevCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
        $prevProtocol = [System.Net.ServicePointManager]::SecurityProtocol
        $ok = $false
        try {
            $proto = [System.Net.SecurityProtocolType]::Tls12
            if ([System.Net.SecurityProtocolType].GetEnumNames() -contains 'Tls13') {
                $proto = $proto -bor [System.Net.SecurityProtocolType]::Tls13
            }
            [System.Net.ServicePointManager]::SecurityProtocol = $proto
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
            $tally    = @{}
            $attempts = 0
            $deadline = (Get-Date).AddSeconds($timeoutSec)
            while ((Get-Date) -lt $deadline) {
                $attempts++
                $reason = ''
                try {
                    # ⛔ HttpWebRequest, NOT Invoke-WebRequest. MEASURED on Windows 11
                    # / PowerShell 5.1 against this installer's own self-signed
                    # certificate: four clients, same server, same cert, same
                    # moment --
                    #     Invoke-WebRequest      FAILED "The underlying connection
                    #                            was closed: An unexpected error
                    #                            occurred on a send."
                    #     HttpWebRequest         HTTP 200
                    #     curl.exe               200
                    #     TcpClient + SslStream  HTTP/1.1 200 OK
                    # The TLS handshake itself SUCCEEDS in every case (the server
                    # logged "HANDSHAKE OK: TLSv1.2 ECDHE-RSA-AES128-GCM-SHA256"
                    # for the failing client too), so this is not the certificate,
                    # not the cipher suite and not the terminator -- it is
                    # Invoke-WebRequest alone.
                    #
                    # ⛔ AND IT MADE THE WHOLE FEATURE UNREACHABLE. Gate 3 is the
                    # proof that the terminator works; with this probe it could
                    # never return 200, so every install moved the consoles to
                    # loopback, failed the gate, and reverted. The cutover could
                    # not have engaged on ANY Windows box. Found only by running
                    # the install for real -- a parse check cannot see it.
                    $req = [System.Net.HttpWebRequest]::Create($url)
                    # 20 s, not 5. This probe pays the terminator hop ON TOP of
                    # the console's own response time, and logvault's
                    # /api/health is itself a rewrite to the Express API on
                    # :3005 - measured at 1.2-1.9 s on production before any
                    # TLS is involved. Gate 3 must not fail a console for being
                    # the slowest of the four when it is answering correctly.
                    $req.Timeout          = 20000
                    $req.ReadWriteTimeout = 20000
                    $req.Method           = 'GET'
                    $req.Proxy            = $null
                    # Per-request as well as the global above: the global callback
                    # is what Invoke-WebRequest was also relying on, so do not
                    # depend on it alone.
                    $req.ServerCertificateValidationCallback = { $true }
                    $resp = $req.GetResponse()
                    $code = [int]$resp.StatusCode
                    $resp.Close()
                    if ($code -eq 200) { $ok = $true; break }
                    $reason = "HTTP $code"
                } catch {
                    $reason = $_.Exception.Message
                    if (-not $reason) { $reason = $_.Exception.GetType().FullName }
                }
                if (-not $tally.ContainsKey($reason)) { $tally[$reason] = 0 }
                $tally[$reason] = $tally[$reason] + 1
                Start-Sleep -Seconds 1
            }
        } finally {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $prevCallback
            [System.Net.ServicePointManager]::SecurityProtocol = $prevProtocol
        }
        if (-not $ok) {
            $parts = @()
            foreach ($k in ($tally.Keys | Sort-Object { $tally[$_] } -Descending)) {
                $parts += ("{0}x {1}" -f $tally[$k], $k)
            }
            $script:LastProbeSummary = "$attempts attempt(s) over ${timeoutSec}s: " + ($parts -join ' | ')
        }
        return $ok
    }

    # ---- the consoles, and only the consoles ----------------------------
    # The Express APIs (3005/3007/3009), the agent-ingest WebSockets (3010/3011)
    # and all three collectors are NOT touched by any of this. They are not
    # fronted by the terminator and nothing below names them.
    $TlsHost = if ($TlsPublicHostValue) { $TlsPublicHostValue } else { $ServerIP }
    $NVStandaloneDir = "$NVAppDir\.next\standalone"

    $Consoles = @()
    $Consoles += [pscustomobject]@{
        App = 'netvault'; Service = 'NetVault'; Public = 3000; Loopback = 13000
        # ⛔ Next's GENERATED standalone server.js reads
        # `process.env.HOSTNAME || '0.0.0.0'`. PORT alone moves the port and
        # leaves it bound on every interface, so 13000 would be a SECOND
        # publicly reachable plain-HTTP copy of the hub sitting behind the
        # terminator - strictly worse than before this step ran.
        Mode = 'standalone'
        EnvFiles = @("$NVAppDir\.env", "$NVStandaloneDir\.env.local")
    }
    if ($InstallLogVault) {
        $Consoles += [pscustomobject]@{
            App = 'logvault'; Service = 'LogVault-App'; Public = 3004; Loopback = 13004
            Mode = 'next-start'
            EnvFiles = @("$LVAppDir\.env.local", "$LVAppDir\frontend\.env.local")
        }
    }
    if ($InstallDDIVault) {
        $Consoles += [pscustomobject]@{
            App = 'ddivault'; Service = 'DDIVault-App'; Public = 3006; Loopback = 13006
            Mode = 'next-start'
            EnvFiles = @("$DDIAppDir\.env.local", "$DDIAppDir\frontend\.env.local")
        }
    }
    if ($InstallSpanVault) {
        $Consoles += [pscustomobject]@{
            App = 'spanvault'; Service = 'SpanVault-App'; Public = 3008; Loopback = 13008
            Mode = 'next-start'
            EnvFiles = @("$SVAppDir\.env.local", "$SVAppDir\frontend\.env.local")
        }
    }

    # ---- SNAPSHOT (before anything is touched) --------------------------
    # The whole FILE is snapshotted, not just the NEXTAUTH_URL line: this step
    # also rewrites the suite probe URLs into NetVault's two env files, and a
    # verbatim restore puts every one of them back in a single operation with
    # nothing to enumerate and therefore nothing to forget. Same shape as
    # Update-NetVault.ps1's $envBackup / $standaloneEnvBackup.
    Write-Info "Snapshotting console service + env state for an automatic revert"
    $snapshotOk = $true
    foreach ($c in $Consoles) {
        $c | Add-Member -NotePropertyName PrevParams   -NotePropertyValue (Get-NssmSetting $NssmExe $c.Service 'AppParameters')
        $c | Add-Member -NotePropertyName PrevEnvExtra -NotePropertyValue (Get-NssmSetting $NssmExe $c.Service 'AppEnvironmentExtra')
        $files = @{}
        foreach ($f in $c.EnvFiles) {
            if (Test-Path -LiteralPath $f) {
                $txt = $null
                try { $txt = (Get-Content -LiteralPath $f -Raw -ErrorAction Stop) } catch { $txt = $null }
                if ($null -eq $txt) {
                    Write-Warn "Could not read $f - refusing the cutover (a state that cannot be snapshotted cannot be reverted)"
                    $snapshotOk = $false
                } else {
                    $files[$f] = $txt
                }
            }
        }
        $c | Add-Member -NotePropertyName PrevEnvFiles -NotePropertyValue $files
        if ($c.Mode -eq 'standalone') {
            if (-not ($c.PrevEnvExtra -match '(?m)^\s*PORT\s*=')) {
                Write-Warn "NetVault service environment has no PORT entry to move - refusing the cutover"
                $snapshotOk = $false
            }
        } else {
            # ⛔ BOTH SPELLINGS. Next accepts `-p <n>` and `--port <n>`, and
            # real installations carry both: measured on production, DDIVault
            # and SpanVault were registered with `-p 3006` / `-p 3008` while
            # LogVault, registered by an older build, runs
            # `cmd.exe /c ...\next.cmd start --port 3004`. Matching only `-p`
            # refused that console and so refused the whole cutover.
            if (-not ($c.PrevParams -match ('(?:^|\s)(?:-p|--port)\s+' + $c.Public + '(?:\s|$)'))) {
                Write-Warn "$($c.Service) AppParameters contains neither '-p $($c.Public)' nor '--port $($c.Public)' - refusing the cutover rather than guessing its command line"
                $snapshotOk = $false
            }
        }
    }

    # ---- APPLY / REVERT -------------------------------------------------
    function Set-ConsoleTransport($console, [string]$nssmExe, [string]$publicHost) {
        # BOTH halves of one console in one function, on purpose. The bind and
        # the NEXTAUTH_URL scheme are a single fact; splitting them is how a
        # suite ends up serving https while NextAuth believes it is http, which
        # bounces every sign-in back to the login page with nothing logged
        # anywhere to say why.
        if ($console.Mode -eq 'standalone') {
            $lines = @($console.PrevEnvExtra -split "`r?`n" |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' })
            if ($lines.Count -lt 2) { return $false }
            $out = @()
            $sawPort = $false
            $sawHost = $false
            foreach ($l in $lines) {
                $name = ($l -split '=', 2)[0]
                if ($name -eq 'PORT')     { $out += ("PORT=" + $console.Loopback); $sawPort = $true; continue }
                if ($name -eq 'HOSTNAME') { $out += 'HOSTNAME=127.0.0.1';          $sawHost = $true; continue }
                $out += $l
            }
            if (-not $sawPort) { return $false }
            # HOSTNAME is appended rather than assumed - see the note on the
            # netvault console entry above for why its absence is not benign.
            if (-not $sawHost) { $out += 'HOSTNAME=127.0.0.1' }
            $ErrorActionPreference = 'Continue'
            $null = & $nssmExe set $console.Service AppEnvironmentExtra ($out -join "`n") 2>&1
            if ($LASTEXITCODE -ne 0) { return $false }
        } else {
            $newParams = $console.PrevParams -replace ('(?:-p|--port)\s+' + $console.Public + '(?=\s|$)'), ("-p " + $console.Loopback + " -H 127.0.0.1")
            if ($newParams -eq $console.PrevParams) { return $false }
            $ErrorActionPreference = 'Continue'
            $null = & $nssmExe set $console.Service AppParameters $newParams 2>&1
            if ($LASTEXITCODE -ne 0) { return $false }
        }

        $wantUrl = "https://" + $publicHost + ":" + $console.Public

        # ⛔ A SERVICE ENVIRONMENT VARIABLE BEATS EVERY FILE, SO THE FILE ALONE
        # IS NOT ENOUGH. Measured on production: LogVault-App and DDIVault-App
        # (registered by an older build) pin NEXTAUTH_URL in AppEnvironmentExtra.
        # Rewriting only the env file would leave those two consoles serving
        # HTTPS while NextAuth still believed it was http - which bounces every
        # sign-in back to the login page with nothing logged to say why, exactly
        # as the note at the top of this function warns. And gate 3 would NOT
        # have caught it: /api/health returns 200 regardless of NEXTAUTH_URL.
        #
        # ⛔ THE REWRITE IS LINE-BY-LINE AND KEEPS EVERY OTHER LINE VERBATIM.
        # This string carries NETVAULT_DB_PASS and NEXTAUTH_SECRET; rebuilding
        # it from a template would destroy credentials. Nothing is appended
        # either: a console that does NOT pin NEXTAUTH_URL must keep reading it
        # from its file, and adding a service pin here would create exactly the
        # shadowing problem this block exists to undo.
        if ($console.PrevEnvExtra -match '(?m)^\s*NEXTAUTH_URL\s*=') {
            $lines = @($console.PrevEnvExtra -split "`r?`n" |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' })
            if ($lines.Count -lt 1) { return $false }
            $out = @()
            foreach ($l in $lines) {
                if ((($l -split '=', 2)[0]) -eq 'NEXTAUTH_URL') { $out += ("NEXTAUTH_URL=" + $wantUrl) }
                else { $out += $l }
            }
            $ErrorActionPreference = 'Continue'
            $null = & $nssmExe set $console.Service AppEnvironmentExtra ($out -join "`n") 2>&1
            if ($LASTEXITCODE -ne 0) { return $false }
        }

        foreach ($f in $console.EnvFiles) {
            if (Test-Path -LiteralPath $f) {
                $null = Set-EnvFileKey $f 'NEXTAUTH_URL' $wantUrl
            }
        }
        return $true
    }

    # What NEXTAUTH_URL this console will ACTUALLY see: the service environment
    # wins over the files, and the first file that carries it wins over the rest.
    function Get-EffectiveNextAuthUrl($console, [string]$nssmExe) {
        $extra = Get-NssmSetting $nssmExe $console.Service 'AppEnvironmentExtra'
        foreach ($l in ($extra -split "`r?`n")) {
            if ($l -match '^\s*NEXTAUTH_URL\s*=\s*(.+?)\s*$') { return $Matches[1] }
        }
        foreach ($f in $console.EnvFiles) {
            if (-not (Test-Path -LiteralPath $f)) { continue }
            foreach ($l in (Get-Content -LiteralPath $f -ErrorAction SilentlyContinue)) {
                if ($l -match '^\s*NEXTAUTH_URL\s*=\s*(.+?)\s*$') { return $Matches[1] }
            }
        }
        return ''
    }

    function Restore-ConsoleTransport($console, [string]$nssmExe) {
        # ⛔ RESTORE EVERYTHING Set-ConsoleTransport CAN WRITE, FOR EVERY MODE.
        # This used to restore AppEnvironmentExtra only for 'standalone' and
        # AppParameters only for the others, because that was all each mode
        # wrote. When NEXTAUTH_URL-in-the-service-environment handling was added
        # it became a write for EVERY mode - and the restore was not widened to
        # match.
        #
        # The result, on production: the cutover failed at the loopback check
        # and reverted, and the revert put the AppParameters back but left
        # LogVault and DDIVault pinned to https://… in their service
        # environment while they served plain HTTP again. Both consoles looked
        # perfectly healthy - /api/health was 200 - and sign-in was broken on
        # both. Found only because the repair script read the value back.
        #
        # An apply and its revert are two halves of one fact. Widening one
        # without the other is how a revert leaves a worse state than the
        # failure it was recovering from, which is the one thing a revert may
        # never do. Restoring unconditionally also makes this correct for
        # whatever the apply learns to write next.
        $ErrorActionPreference = 'Continue'
        if ($console.PrevEnvExtra) {
            $lines = @($console.PrevEnvExtra -split "`r?`n" |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' })
            # A floor, not a mode test: an empty parse would blank an
            # environment that carries DATABASE_URL and NEXTAUTH_SECRET.
            if ($lines.Count -ge 1) { $null = & $nssmExe set $console.Service AppEnvironmentExtra ($lines -join "`n") 2>&1 }
        }
        if ($console.PrevParams) {
            $null = & $nssmExe set $console.Service AppParameters $console.PrevParams 2>&1
        }
        foreach ($f in $console.PrevEnvFiles.Keys) {
            try { $console.PrevEnvFiles[$f] | Out-File -FilePath $f -Encoding UTF8 -NoNewline } catch {}
        }
    }

    # Undo EVERYTHING this step did, including the service itself, and put the
    # consoles back on the air. Called from every failure path below.
    function Undo-TlsCutover([string]$reason, $consoles, [string]$nssmExe) {
        Write-Warn "REVERTING the TLS cutover - $reason"
        $null = & sc.exe stop NocVault-Tls 2>&1
        Start-Sleep -Seconds 2
        $null = & $nssmExe stop NocVault-Tls confirm 2>&1
        $null = & $nssmExe remove NocVault-Tls confirm 2>&1
        # EVERY console, not only the ones this run got as far as changing.
        # Restoring one that was never touched rewrites it with the byte-identical
        # snapshot taken before anything happened, so it is a no-op - and
        # tracking "which ones did I reach" would be one more thing to get
        # wrong on the path that exists to be reliable.
        foreach ($c in $consoles) {
            Restore-ConsoleTransport $c $nssmExe
            $null = Restart-NocService $c.Service
        }
        Start-Sleep -Seconds 5
        $backUp = $true
        foreach ($c in $consoles) {
            if (Wait-HttpOk ("http://127.0.0.1:" + $c.Public + "/api/health") 60) {
                Write-OK "$($c.App) is back on plain HTTP :$($c.Public)"
            } else {
                Write-Warn "$($c.App) did NOT answer http://127.0.0.1:$($c.Public)/api/health after the revert - check $($c.Service) and its log"
                $backUp = $false
            }
        }
        if ($backUp) {
            Write-OK "Revert complete - the suite is in its normal plain-HTTP configuration"
        } else {
            Write-Warn "Revert finished with at least one console not answering. The suite is NOT serving HTTPS; fix the service above before retrying TLS."
        }
    }

    if (-not $snapshotOk) {
        Write-Warn "Pre-cutover snapshot incomplete - the TLS terminator will NOT be installed and nothing has been changed."
    } else {
        # ---- register the service (registered stopped; started below) ----
        $TlsLog    = "$NVDir\logs\nocvault-tls.log"
        $TlsErrLog = "$NVDir\logs\nocvault-tls-error.log"
        # Truncate the previous run's logs so the NOT STARTED banner check below
        # cannot be answered by an old banner from a prior install attempt.
        foreach ($lf in @($TlsLog, $TlsErrLog)) {
            if (Test-Path -LiteralPath $lf) { Remove-Item -LiteralPath $lf -Force -ErrorAction SilentlyContinue }
        }
        $TlsDeps = @()
        foreach ($c in $Consoles) { $TlsDeps += $c.Service }

        & $NssmExe stop NocVault-Tls confirm 2>$null
        & $NssmExe remove NocVault-Tls confirm 2>$null
        & $NssmExe install NocVault-Tls "C:\Program Files\nodejs\node.exe" "$NVAppDir\installer\terminator\start.mjs"
        # AppDirectory is the NetVault repo root, not installer\terminator: the
        # terminator resolves <root>\.env and <root>\.next\standalone\.env.local
        # from its own module path, but every log path, relative import and
        # git-root probe is clearer from the root the rest of the app uses.
        & $NssmExe set NocVault-Tls AppDirectory        $NVAppDir
        # ⛔ NODE_ENV ONLY. The TLS pair, TLS_PUBLIC_HOST and the ports are all
        # ABSENT here and that is deliberate - see the long note at $NVEnvTail
        # above. TLS_CERT_PATH/TLS_KEY_PATH are lib/envTargets.ts MANAGED_KEYS
        # that Settings rewrites at runtime; a value pinned in a service
        # environment is read at runtime and beats any file, so pinning them
        # would make every future certificate change from Settings a silent
        # no-op for the one process that actually terminates TLS. The terminator
        # already reads those two files itself (loadEnvironment()).
        & $NssmExe set NocVault-Tls AppEnvironmentExtra "NODE_ENV=production"
        & $NssmExe set NocVault-Tls DisplayName         "NocVault - TLS Terminator"
        & $NssmExe set NocVault-Tls Description         "NocVault Suite - shared HTTPS front door for all four consoles"
        & $NssmExe set NocVault-Tls Start               SERVICE_AUTO_START
        # The four consoles, so a reboot brings the upstreams up first. This is
        # ordering only - Windows does not wait for an upstream to be READY, and
        # the terminator does not need it to be: a console that is still starting
        # produces a 502 from that one listener, not a failure to bind.
        & $NssmExe set NocVault-Tls DependOnService     ($TlsDeps -join "`n")
        & $NssmExe set NocVault-Tls AppStdout           $TlsLog
        & $NssmExe set NocVault-Tls AppStderr           $TlsErrLog
        & $NssmExe set NocVault-Tls AppRotateFiles      1
        & $NssmExe set NocVault-Tls AppRotateBytes      10485760
        & $NssmExe set NocVault-Tls AppRotateOnline     1
        & $NssmExe set NocVault-Tls AppRestartDelay     3000
        # See the NetVault block for why 15000 and not NSSM's 1500ms default:
        # the terminator tracks and tears down every live socket on stop,
        # including upgraded WebSockets, and must not be killed mid-drain.
        & $NssmExe set NocVault-Tls AppStopMethodConsole 15000
        Write-OK "NocVault-Tls service registered (not started yet)"

        # ---- move the consoles to loopback ------------------------------
        Write-Info "Moving the consoles to 127.0.0.1 and NEXTAUTH_URL to https:// (reversible from here)"
        $moveOk = $true
        foreach ($c in $Consoles) {
            if (Set-ConsoleTransport $c $NssmExe $TlsHost) {
                Write-OK "$($c.App): 127.0.0.1:$($c.Loopback), NEXTAUTH_URL https://${TlsHost}:$($c.Public)"
            } else {
                Write-Warn "$($c.App): could not rewrite $($c.Service) - aborting the cutover"
                $moveOk = $false
                break
            }
        }

        # ---- point the hub's suite probes at the loopback ports ----------
        # app/api/suite/{health,stats} default to http://127.0.0.1:300X, which
        # after the move is the TERMINATOR. A plain-HTTP probe there gets the
        # demux 301 to https, and the follow-up fails certificate validation
        # against 127.0.0.1 - so the launcher's Suite Health and stat tiles
        # would all read "Unavailable". No code change: these env overrides are
        # already honoured.
        if ($moveOk) {
            $probePairs = @{}
            foreach ($c in $Consoles) {
                $probePairs[($c.App.ToUpper() + "_HEALTH_URL")] = ("http://127.0.0.1:" + $c.Loopback + "/api/health")
                # There is no NETVAULT_STATS_URL - the hub reads its own stats
                # in-process and app/api/suite/stats lists only the three
                # satellites.
                if ($c.App -ne 'netvault') {
                    $probePairs[($c.App.ToUpper() + "_STATS_URL")] = ("http://127.0.0.1:" + $c.Loopback + "/api/stats")
                }
            }
            foreach ($f in @("$NVAppDir\.env", "$NVStandaloneDir\.env.local")) {
                if (Test-Path -LiteralPath $f) {
                    foreach ($k in $probePairs.Keys) { $null = Set-EnvFileKey $f $k $probePairs[$k] }
                }
            }
            Write-OK "Suite health/stats probes repointed at the loopback ports"
        }

        if (-not $moveOk) {
            Undo-TlsCutover "a console service could not be reconfigured" $Consoles $NssmExe
        } else {
            # ---- restart the consoles and prove them on loopback ---------
            foreach ($c in $Consoles) { $null = Restart-NocService $c.Service }
            Start-Sleep -Seconds 5
            $loopbackOk = $true
            foreach ($c in $Consoles) {
                if (Wait-HttpOk ("http://127.0.0.1:" + $c.Loopback + "/api/health") 90) {
                    Write-OK "$($c.App) answering on 127.0.0.1:$($c.Loopback)"
                } else {
                    Write-Warn "$($c.App) did NOT answer on 127.0.0.1:$($c.Loopback)"
                    # The probe's OWN account of what it saw, every attempt
                    # tallied. Without this the next line of defence is a fresh
                    # request from the diagnostics block below - which, every
                    # time this has fired on production, has returned HTTP 200
                    # and left the actual failure unexplained.
                    if ($script:LastProbeSummary) {
                        Write-Info "  probe said      : $($script:LastProbeSummary)"
                    }
                    # ⛔ SAY WHY, NOT JUST THAT. This line used to be the entire
                    # record of a failed cutover: "did NOT answer", then a
                    # revert, and nothing to work from. It cost a production
                    # evening of guessing - four hypotheses tested and all four
                    # wrong - because the one machine that knew what happened
                    # had thrown the evidence away. Everything below is read
                    # AFTER the failure, from the live system.
                    $ErrorActionPreference = 'Continue'
                    try {
                        # ⛔ "DID NOT ANSWER" CONFLATES TWO VERY DIFFERENT
                        # FAULTS. Wait-HttpOk treats anything that is not a 200
                        # as a reason to keep waiting, so a console that never
                        # started and one that started and returns 500 both end
                        # up here. They need opposite fixes. The probe's own
                        # tally (printed above) names which it was; this extra
                        # request then reports the CURRENT state verbatim, which
                        # is how we learned the console was healthy all along.
                        $probeUrl = "http://127.0.0.1:" + $c.Loopback + "/api/health"
                        try {
                            $pr = [Net.HttpWebRequest]::Create($probeUrl)
                            $pr.Timeout = 8000
                            $presp = $pr.GetResponse()
                            $pcode = [int]$presp.StatusCode
                            $pbody = (New-Object IO.StreamReader($presp.GetResponseStream())).ReadToEnd()
                            $presp.Close()
                            Write-Info "  final probe     : HTTP $pcode - $($pbody.Substring(0, [Math]::Min(160, $pbody.Length)))"
                        } catch [Net.WebException] {
                            $we = $_.Exception
                            if ($we.Response) {
                                $wc = [int]$we.Response.StatusCode
                                $wb = ''
                                try { $wb = (New-Object IO.StreamReader($we.Response.GetResponseStream())).ReadToEnd() } catch {}
                                Write-Info "  final probe     : HTTP $wc (the console IS listening and answering, just not 200) - $($wb.Substring(0, [Math]::Min(160, $wb.Length)))"
                            } else {
                                Write-Info "  final probe     : no response at all ($($we.Status)) - nothing is listening on that port"
                            }
                        } catch {
                            Write-Info "  final probe     : $($_.Exception.Message)"
                        }
                        $svcNow = Get-Service -Name $c.Service -ErrorAction SilentlyContinue
                        Write-Info "  service state   : $(if ($svcNow) { $svcNow.Status } else { 'NOT FOUND' })"
                        Write-Info "  AppParameters   : $(Get-NssmSetting $NssmExe $c.Service 'AppParameters')"
                        foreach ($port in @($c.Loopback, $c.Public)) {
                            $lc = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
                            if ($lc) { Write-Info ("  port {0,-6}     : listening on {1} (pid {2})" -f $port, (($lc.LocalAddress | Select-Object -Unique) -join ','), (($lc.OwningProcess | Select-Object -Unique) -join ',')) }
                            else     { Write-Info ("  port {0,-6}     : nothing listening" -f $port) }
                        }
                        # The console's own output is the only place a startup
                        # error appears at all; NSSM only writes it when the
                        # service has AppStdout/AppStderr configured.
                        foreach ($k in 'AppStderr','AppStdout') {
                            $lf = Get-NssmSetting $NssmExe $c.Service $k
                            if ($lf -and (Test-Path -LiteralPath $lf)) {
                                $tail = @(Get-Content -LiteralPath $lf -Tail 6 -ErrorAction SilentlyContinue)
                                if ($tail.Count -gt 0) {
                                    Write-Info "  $k ($lf):"
                                    foreach ($t in $tail) { Write-Info "      $($t.TrimEnd())" }
                                }
                            } else {
                                Write-Info "  $k : not configured, so the console's startup output was not captured anywhere"
                            }
                        }
                    } catch {
                        Write-Info "  (could not collect diagnostics: $($_.Exception.Message))"
                    }
                    $loopbackOk = $false
                }
            }

            if (-not $loopbackOk) {
                Undo-TlsCutover "a console did not come back up on its loopback port" $Consoles $NssmExe
            } else {
                # ---- start the terminator and prove GATE 3 ---------------
                Write-Info "Starting NocVault-Tls"
                $ErrorActionPreference = 'Continue'
                $null = & sc.exe start NocVault-Tls 2>&1
                Start-Sleep -Seconds 6

                $gate3 = $true
                foreach ($c in $Consoles) {
                    if (Wait-HttpsOk ("https://127.0.0.1:" + $c.Public + "/api/health") 60) {
                        Write-OK "HTTPS 200 for $($c.App) through the terminator on :$($c.Public)"
                    } else {
                        Write-Warn "No HTTPS 200 for $($c.App) on :$($c.Public)"
                        if ($script:LastProbeSummary) {
                            Write-Info "  probe said      : $($script:LastProbeSummary)"
                        }
                        $gate3 = $false
                    }
                }

                # The terminator REFUSES to start (rather than serving
                # plaintext) on a runtime that cannot load lib/tlsConfig.ts, and
                # says so with a named banner. Gate 2 should have caught that
                # case already; this is the belt to its braces, and it also
                # catches the banner appearing for any reason gate 2 could not
                # foresee. Any occurrence fails the cutover.
                $tlsLogText = ""
                foreach ($lf in @($TlsErrLog, $TlsLog)) {
                    if (Test-Path -LiteralPath $lf) {
                        try { $tlsLogText += (Get-Content -LiteralPath $lf -Raw -ErrorAction Stop) } catch {}
                    }
                }
                if ($tlsLogText -match 'NOT STARTED') {
                    Write-Warn "The terminator logged its 'NOT STARTED' banner - it is not serving anything"
                    $gate3 = $false
                }

                $svcTls = Get-Service -Name NocVault-Tls -ErrorAction SilentlyContinue
                if (-not ($svcTls -and $svcTls.Status -eq 'Running')) {
                    Write-Warn "NocVault-Tls is not Running"
                    $gate3 = $false
                }

                # ⛔ GATE 3b — THE ONE GATE 3 CANNOT SEE. Gate 3 asks for a 200
                # on /api/health over HTTPS, and /api/health does not care what
                # NEXTAUTH_URL says. So a console whose NEXTAUTH_URL is still
                # http:// passes gate 3 perfectly and then bounces every single
                # sign-in back to the login page with nothing logged to explain
                # it - a suite that looks completely healthy and cannot be
                # logged into. Found on production, where two consoles pinned
                # NEXTAUTH_URL in their SERVICE ENVIRONMENT, which beats the
                # file the cutover rewrites.
                #
                # This reads back what each console will ACTUALLY see, after the
                # fact, from the same precedence the app uses. A gate that
                # re-derives what we just wrote would prove nothing.
                if ($gate3) {
                    foreach ($c in $Consoles) {
                        $eff = Get-EffectiveNextAuthUrl $c $NssmExe
                        if ($eff -notlike 'https://*') {
                            Write-Warn "$($c.App): NEXTAUTH_URL is still '$eff' after the cutover - sign-in would be broken on a console that otherwise looks healthy"
                            $gate3 = $false
                        } else {
                            Write-OK "$($c.App): NEXTAUTH_URL is $eff"
                        }
                    }
                    if (-not $gate3) {
                        Write-Warn "GATE 3b FAIL - HTTPS works but at least one console would refuse every sign-in. Reverting."
                    }
                }

                if (-not $gate3) {
                    Undo-TlsCutover "the terminator did not prove itself on all four public ports, or a console's NEXTAUTH_URL was still http" $Consoles $NssmExe
                } else {
                    $script:TlsCutoverApplied = $true
                    Write-OK "GATE 3 PASS - NocVault-Tls is terminating TLS for every installed console"
                    Write-OK "Consoles are now bound to 127.0.0.1 only; 3000/3004/3006/3008 are the terminator"

                    # ---- re-point the NetVault cron tasks ------------------
                    # ⛔ THE THREE SCHEDULED TASKS POST TO http://127.0.0.1:3000,
                    # which is now the TERMINATOR. curl.exe without -L would
                    # take the demux 301 and do nothing; with -L it would fail
                    # certificate validation against 127.0.0.1. Left alone,
                    # health snapshots, EOL enrichment and the weekly feed sync
                    # all stop silently - no error anywhere, just a trend chart
                    # that never gains a point. Re-registered against the hub's
                    # own loopback port, which is not fronted by anything.
                    $nvCronPort = $Consoles[0].Loopback
                    $snapA = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:$nvCronPort/api/system/health-snapshot -H `"Authorization: Bearer $CronSecret`""
                    Register-MaintenanceTask "NetVault-HealthSnapshot" $snapA (New-ScheduledTaskTrigger -Daily -At "00:00") "daily 00:00"
                    $eolA  = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:$nvCronPort/api/system/enrich-eol -H `"Authorization: Bearer $CronSecret`""
                    Register-MaintenanceTask "NetVault-EnrichEol" $eolA (New-ScheduledTaskTrigger -Daily -At "01:00") "daily 01:00"
                    $syncA = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:$nvCronPort/api/system/sync-eol -H `"Authorization: Bearer $CronSecret`""
                    Register-MaintenanceTask "NetVault-SyncEol" $syncA (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "00:15") "weekly Sun 00:15"
                    # ⛔ VERIFY, DO NOT ANNOUNCE. This line used to print
                    # unconditionally, directly beneath three calls that had
                    # just failed. Read the registered tasks back and say what
                    # is actually true.
                    $cronOk = 0; $cronBad = @()
                    foreach ($tn in 'NetVault-HealthSnapshot','NetVault-EnrichEol','NetVault-SyncEol') {
                        $t = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
                        $arg = ''
                        if ($t) { $arg = ($t.Actions | ForEach-Object { $_.Arguments }) -join ' ' }
                        if ($arg -match ("127\.0\.0\.1:" + $nvCronPort + "/")) { $cronOk++ } else { $cronBad += $tn }
                    }
                    if ($cronBad.Count -eq 0) {
                        Write-OK "NetVault cron tasks re-pointed at 127.0.0.1:$nvCronPort ($cronOk of 3 verified)"
                    } else {
                        Write-Warn "NetVault cron tasks NOT re-pointed: $($cronBad -join ', '). They will keep posting to the terminator's port and will stop working silently - no error, just a health trend that never gains a point. Re-point them by hand, or re-run this script."
                    }

                    # ---- firewall ------------------------------------------
                    # 3000/3004/3006/3008 are already open from the per-app
                    # steps above and stay open - same ports, now TLS. Nothing
                    # to add and nothing to remove.
                    #
                    # ⛔ 13000/13004/13006/13008 ARE NEVER OPENED. They are the
                    # consoles themselves, speaking plain HTTP with no
                    # authentication boundary in front of them; a rule here
                    # would hand the world an unencrypted bypass around the
                    # thing this whole step exists to install. They are bound to
                    # 127.0.0.1 as well, so this is the second of two locks.
                    if ($OpenHttpRedirectPorts) {
                        foreach ($c in $Consoles) {
                            $rp = $c.Public + 80
                            Add-NocFirewallRule -DisplayName "NocVault TLS redirect $rp" -Protocol TCP -LocalPort $rp
                        }
                        Write-OK "Firewall rules added for the dedicated HTTP redirect ports (3080/3084/3086/3088)"
                    } else {
                        Write-Info "Dedicated HTTP redirect ports left closed (old http:// bookmarks are already answered with a 301 on the TLS port itself). Pass -OpenHttpRedirectPorts to open them."
                    }
                }
            }
        }
    }
}
