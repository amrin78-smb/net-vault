#
# installer\NocVault-TlsPreflight.ps1 — gates 1 and 2, and the certificate.
#
# ⛔ DOT-SOURCED, NOT RUN. Like NocVault-TlsCutover.ps1 beside it, this has no
# param() and defines no function: it runs in the CALLER'S SCOPE so the body
# could be MOVED rather than retyped. It is byte-for-byte the preflight that was
# proven on real Windows during the staging dry run.
#
# Two callers: Install-NocVault-Suite.ps1 (a fresh install) and
# Enable-NocVaultTls.ps1 (an installation that already exists).
#
# ⛔ THE CALLER MUST SET THESE FIRST:
#   $TlsCertPath $TlsKeyPath $TlsPublicHost   (may be '')
#   $NoSelfSignedTls                          [switch]
#   $ServerIP                                 the address the consoles are on
#   $script:TlsHelperLoaded / $script:TlsHelperError   from NocVault-Tls.ps1
#
# ⛔ IT DECIDES, IT DOES NOT ACT. The only thing it writes is a certificate pair
# under C:\ProgramData\NocVault\certs, and only when neither path parameter was
# supplied and one is not already there. It binds no port, registers no service
# and edits no env file — so a preflight whose gates then fail leaves the
# installation exactly as it found it.
#
# Sets for the caller: $TlsGateOk, $TlsGateReason, $TlsCert, $TlsKey,
# $TlsPublicHostValue, $NodeExe, $CertDir.
#

# ================================================================
# STEP 4b — TLS terminator preflight (mints a certificate; DECIDES the rest)
# ================================================================
# ⛔ READ THIS BEFORE TOUCHING STEP 12.5.
#
# Moving the four consoles onto 127.0.0.1 is what turns the shared terminator
# into a security boundary. It is ALSO the single change in this installer that
# can make an entire customer suite unreachable: loopback consoles plus a
# terminator that did not start means all four web UIs are gone, with no way
# back in except console access to the box.
#
# So the loopback move and the terminator are gated on EACH OTHER, through
# three gates that must ALL hold. This step establishes the first two; it binds
# nothing, writes no service and edits no env file.
#
#   gate 1  a certificate PAIR is configured and both files exist.
#   gate 2  the Node that will run the service can actually execute TypeScript.
#   gate 3  (STEP 12.5) the terminator is PROVEN answering HTTPS on all four
#           public ports, with no "NOT STARTED" banner in its log.
#
# Fail any gate and the suite installs byte-for-byte as it always has: four
# consoles on 0.0.0.0:3000/3004/3006/3008 over plain HTTP, NEXTAUTH_URL http://,
# no NocVault-Tls service. There is no partial state to land in.
#
# ⛔ ONE THING HAPPENS HERE BEFORE ANY GATE IS JUDGED: IF NO CERTIFICATE IS
# CONFIGURED, ONE IS MINTED. That is the ONLY change to this step's behaviour,
# and it is why "the suite installs on plain HTTP" is now the EXCEPTION rather
# than the rule. The reasoning is SecVault's, which has shipped it since its
# v2.112.0: a terminator that engages only when the customer has already
# supplied a certificate engages almost never, so every console in the field
# stayed on plain HTTP - and plain HTTP on an administrator console is a worse
# outcome than a self-signed certificate an operator replaces from Settings.
# The earlier note here argued the opposite (that a self-signed certificate
# "trains every administrator to click through a browser warning, which is
# worse than plain HTTP because it looks safe"). That trade was reconsidered
# deliberately: a browser warning is VISIBLE and fixable, while unencrypted
# session cookies on a flat management LAN are neither.
#
# ⛔ GATE 1 IS STILL BOTH-OR-NEITHER, mirroring lib/tlsConfig.ts exactly, and the
# mint does NOT soften it. One path set alone is a half-finished configuration,
# not a disabled one, and calling it "TLS off" would silently ignore an operator
# who has clearly started turning it on - so a HALF-configured pair is still
# refused and is deliberately NOT completed by minting the missing half, which
# would pair a certificate with a key that does not match it.
#
# ⛔ AND THE MINT NEVER OVERWRITES. New-NocVaultCertificate's first act is to
# succeed without recreating anything when both files are present; that, not a
# condition in this step, is what makes an operator's real corporate
# certificate survive every re-run of this installer.
#
# ⛔ GATE 2 IS DETECTED BY ATTEMPTING IT, NEVER FROM A VERSION TABLE. That is the
# same rule installer\terminator\start.mjs follows, for the same reason: "which
# Node can strip types" (22.6 flagged, 22.18 unflagged, 23.6 unflagged, 20
# never) is a second source of truth that goes stale, and a stale copy of it
# here decides whether a customer's four consoles are reachable.
Write-Step "TLS terminator preflight (certificate + gates 1 and 2)"

# Run a throwaway .ts file and see whether Node accepts it.
#
# The probe file carries a TYPE ANNOTATION on purpose: a .ts that is also valid
# JavaScript would load on a Node that cannot strip types and pass the probe.
#
# try/catch, never a bare 2>$null - on a box where $nodeExe is not a real path,
# PowerShell's own command resolution throws a TERMINATING error before any
# process exists to redirect a stderr stream from (same gotcha as the Node/Git
# "is it installed" checks above). $ErrorActionPreference is assigned inside the
# function, which is function-scoped and reverts on return.
function Test-NodeCanRunTypeScript([string]$nodeExe) {
    $probeDir = Join-Path $env:TEMP ("nocvault-ts-probe-" + [guid]::NewGuid().ToString('N'))
    $ok = $false
    try {
        New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
        $probeFile = Join-Path $probeDir 'probe.ts'
        Set-Content -LiteralPath $probeFile -Encoding ASCII -Value 'const marker: string = "NOCVAULT_TS_OK"; console.log(marker)'
        $ErrorActionPreference = 'Continue'
        # Assign first: PowerShell 5.1 cannot pipe a command directly out of a
        # try block, so the capture and the test are separate statements.
        $probeOut = & $nodeExe $probeFile 2>&1
        $probeExit = $LASTEXITCODE
        $probeText = ($probeOut | Out-String)
        if ($probeExit -eq 0 -and $probeText -match 'NOCVAULT_TS_OK') { $ok = $true }
    } catch {
        $ok = $false
    } finally {
        try {
            if (Test-Path -LiteralPath $probeDir) {
                Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    return $ok
}

$NodeExe            = "C:\Program Files\nodejs\node.exe"
$CertDir            = 'C:\ProgramData\NocVault\certs'
$TlsPublicHostValue = $TlsPublicHost.Trim()
$TlsCert            = $TlsCertPath.Trim()
$TlsKey             = $TlsKeyPath.Trim()

# The convention path is probed so the graphical installer (which cannot pass new
# arguments without an .exe rebuild) can still enable TLS: drop the pair in
# $CertDir as nocvault.crt / nocvault.key before running setup. It is ALSO where
# the self-signed pair is minted, so the GUI install gets HTTPS with no
# arguments at all.
#
# ⛔ THE MINT RUNS ONLY WHEN NEITHER PATH PARAMETER WAS SUPPLIED. An operator who
# passed -TlsCertPath/-TlsKeyPath has made a choice, and a generated certificate
# must never appear beside it; an operator who passed exactly one has made a
# MISTAKE, and the warning below is the right answer to that, not a silent
# repair with a key that matches nothing.
$script:TlsMint = $null
if ((-not $TlsCert) -and (-not $TlsKey)) {
    if ($NoSelfSignedTls) {
        Write-Info "-NoSelfSignedTls was passed - no certificate will be generated."
    } elseif (-not $script:TlsHelperLoaded) {
        Write-Warn "installer\NocVault-Tls.ps1 $($script:TlsHelperError) - no certificate can be minted, so the suite will install on plain HTTP. Ship the whole installer folder together."
    } else {
        # ⛔ Minting is a FILE WRITE under C:\ProgramData\NocVault\certs and
        # nothing else. It binds no port, registers no service and edits no env
        # file, so this step keeps its "decides only" character: a minted
        # certificate that the gates then reject leaves two unused files behind
        # and changes the installed suite not at all.
        $script:TlsMint = New-NocVaultCertificate -CertDir $CertDir -ServerIp $ServerIP -PublicHost $TlsPublicHostValue
        if ($script:TlsMint.Success) {
            if ($script:TlsMint.Created) {
                Write-OK "Self-signed certificate minted: $($script:TlsMint.CertPath)"
                Write-Info "SANs: $($script:TlsMint.SanParts -join ', ')"
                if ($script:TlsMint.NotAfter) { Write-Info "Expires $($script:TlsMint.NotAfter.ToString('yyyy-MM-dd'))" }
            } else {
                Write-OK "Certificate pair already present in $CertDir - reused, NOT regenerated ($($script:TlsMint.Message))"
            }
        } else {
            # Not fatal, by design: no certificate means gate 1 fails below and
            # the suite installs on plain HTTP, which is exactly what it did
            # before this mint existed.
            Write-Warn "No certificate was generated: $($script:TlsMint.Error)"
            Write-Warn "The suite will install on plain HTTP. Fix the cause (usually a missing openssl.exe) or supply -TlsCertPath/-TlsKeyPath, then re-run."
        }
    }

    $defaultCert = Join-Path $CertDir 'nocvault.crt'
    $defaultKey  = Join-Path $CertDir 'nocvault.key'
    if ((Test-Path -LiteralPath $defaultCert) -and (Test-Path -LiteralPath $defaultKey)) {
        $TlsCert = $defaultCert
        $TlsKey  = $defaultKey
        Write-Info "Certificate pair found in $CertDir"
    }
}

$TlsGateOk     = $false
$TlsGateReason = ""
if ((-not $TlsCert) -and (-not $TlsKey)) {
    $TlsGateReason = "No TLS certificate configured (no -TlsCertPath/-TlsKeyPath and no pair in $CertDir). The suite installs on plain HTTP exactly as before."
    Write-Info $TlsGateReason
} elseif ((-not $TlsCert) -or (-not $TlsKey)) {
    $TlsGateReason = "TLS is HALF-configured - only one of -TlsCertPath / -TlsKeyPath was supplied. Set BOTH, or neither. The terminator will NOT be installed and the consoles stay on plain HTTP."
    Write-Warn $TlsGateReason
} elseif (-not (Test-Path -LiteralPath $TlsCert)) {
    $TlsGateReason = "TLS certificate not found at $TlsCert - the terminator will NOT be installed and the consoles stay on plain HTTP."
    Write-Warn $TlsGateReason
} elseif (-not (Test-Path -LiteralPath $TlsKey)) {
    $TlsGateReason = "TLS key not found at $TlsKey - the terminator will NOT be installed and the consoles stay on plain HTTP."
    Write-Warn $TlsGateReason
} elseif (-not (Test-Path -LiteralPath $NodeExe)) {
    $TlsGateReason = "node.exe not found at $NodeExe - cannot prove the runtime executes TypeScript, so the terminator will NOT be installed."
    Write-Warn $TlsGateReason
} elseif (-not (Test-NodeCanRunTypeScript $NodeExe)) {
    $TlsGateReason = "This Node cannot execute TypeScript, so installer\terminator\start.mjs would refuse to start and the consoles would be unreachable behind a dead terminator. Install Node >= v$NodeRequired and re-run. The terminator will NOT be installed."
    Write-Warn $TlsGateReason
} else {
    $TlsGateOk = $true
}

# What is actually on disk, read back from the certificate itself rather than
# from what this run did. $script:TlsCertFingerprint / $script:TlsCertSelfSigned
# are read by the closing summary.
#
# ⛔ "SELF-SIGNED" IS DECIDED BY subject == issuer, NOT BY "did we mint it". A
# re-install reuses the certificate minted by the previous run, so a
# did-I-create-it flag would stop reporting a self-signed certificate as
# self-signed on every run after the first - and the fingerprint line is the
# only thing telling an operator that their agents need a pin.
$script:TlsCertFingerprint = $null
$script:TlsCertSelfSigned  = $false
$script:TlsCertNotAfter    = $null
if ($TlsGateOk -and $script:TlsHelperLoaded) {
    $tlsInfo = Get-NocVaultCertInfo $TlsCert
    if ($tlsInfo.Ok) {
        $script:TlsCertFingerprint = $tlsInfo.Fingerprint
        $script:TlsCertSelfSigned  = $tlsInfo.SelfSigned
        $script:TlsCertNotAfter    = $tlsInfo.NotAfter
    } else {
        # A certificate the installer cannot parse is NOT reported as fine and
        # is NOT treated as a gate failure either: node may still load it
        # perfectly, and gate 3 is the thing that actually settles whether the
        # terminator serves. Say what could not be measured.
        Write-Warn "Could not read certificate details from $TlsCert ($($tlsInfo.Error)) - no fingerprint can be reported for it."
    }
}

if ($TlsGateOk) {
    Write-OK "Gate 1 PASS - certificate pair present ($TlsCert)"
    Write-OK "Gate 2 PASS - this Node executes TypeScript"
    if ($script:TlsCertFingerprint) {
        Write-Info "Certificate SHA-256: $($script:TlsCertFingerprint)"
    }
    if ($script:TlsCertSelfSigned) {
        # ⛔ A CONSTRAINT SECVAULT DOES NOT HAVE. The agents dial the HUB on port
        # 3000 - the same port the terminator takes over - for /api/agents/enroll,
        # /heartbeat, /policy, /update-manifest and /bundle. A CA-issued
        # certificate is transparent to them; a SELF-SIGNED one is not, so an
        # agent that cannot be told to trust this certificate loses its control
        # channel when the cutover lands. The fingerprint above is what it is
        # told. This is stated here AND in the closing summary because an
        # operator scrolling a 20-minute install sees one of the two.
        Write-Warn "This certificate is SELF-SIGNED. Agents dial the hub on :3000, which the terminator takes over, so an agent's hubUrl must become https:// and should pin the fingerprint above (the agent's 'hubFingerprint' config key)."
        Write-Info "Re-running on a server that already has enrolled agents? Their hubUrl is http://, which the terminator answers with a 301 that the agent does not follow. Update them, or pass -NoSelfSignedTls to stay on plain HTTP until you have."
    }
    Write-Info "The consoles still install on 0.0.0.0. They move to 127.0.0.1 only in STEP 12.5, and only after gate 3."
} else {
    Write-Info "TLS terminator will not be installed - continuing with the plain-HTTP install."
}
