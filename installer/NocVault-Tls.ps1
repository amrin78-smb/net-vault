<#
    NocVault-Tls.ps1 — self-signed certificate minting for the shared TLS
    terminator, dot-sourced by Install-NocVault-Suite.ps1.

    ⛔ WHY THIS EXISTS. The terminator used to engage ONLY when a certificate
    pair was already on disk (STEP 4b gate 1). In practice almost nobody
    supplies one before running setup, so every console in the field stays on
    plain HTTP — which is the state all four are in today. SecVault solved this
    years ago (its installer/SecVault-Tls.ps1, the "TLS (v2.112.0)" section of
    its CLAUDE.md): mint a self-signed certificate when none exists, so HTTPS is
    always on, and let a real corporate certificate replace it later through
    Settings. This file is that port.

    ⛔ IT IS A SEPARATE FILE, NOT MORE LINES IN THE INSTALLER, for the same
    reason SecVault's is: the mint has to be callable from more than one script
    (today only the suite installer; Update-NetVault.ps1 converges TLS_CERT_PATH
    and would be the second caller the moment it ever needs to mint), and two
    copies of certificate logic drift until a fresh install and an upgraded
    install end up in different transport states.

    ⛔ WINDOWS POWERSHELL 5.1 ONLY. No '&&', no '||', no '??', no ternary, no
    '?.', no piping directly out of a try/catch (assign first), no $PID.
    `pwsh` 7 accepts all of those and is NOT a valid gate for this file.

    Nothing in here binds a port, registers a service or edits an env file. It
    writes two files under $CertDir and reports what it did; every decision
    about whether TLS is switched on stays in the installer's three gates.
#>

# ─────────────────────────────────────────────────────────────────────────────
# OpenSSL
#
# ⛔ OPENSSL, NOT New-SelfSignedCertificate. On Windows PowerShell 5.1 the
# latter can only export a PFX — .NET Framework has no PKCS#8 private-key
# export — and the terminator hands node PEM (lib/tlsConfig.ts reads
# TLS_CERT_PATH / TLS_KEY_PATH as files and builds a secure context from them).
#
# ⛔ SAME PATH LIST AS Get-WsTlsOpenSsl IN THE INSTALLER, deliberately. Git for
# Windows is already a hard dependency of this suite and bundles OpenSSL 3.x,
# and the installer already resolves openssl.exe exactly this way for the
# agent-ingest certificates. A second, differently-ordered list would mean two
# answers to "where is openssl" on one box.
#
# ⛔ PATH IS PROBED LAST AND VIA Get-Command. A bare '& openssl' THROWS on a
# machine that genuinely lacks it — PowerShell's own command resolution fails
# before any process exists to redirect a stderr stream from — and that
# terminating error would take the caller down with it. `2>$null` does not help.
# ─────────────────────────────────────────────────────────────────────────────
function Find-NocVaultOpenSsl {
    $paths = @(
        "$env:ProgramFiles\Git\usr\bin\openssl.exe",
        "$env:ProgramFiles\Git\mingw64\bin\openssl.exe",
        "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
        "C:\Program Files\PostgreSQL\16\bin\openssl.exe"
    )
    foreach ($p in $paths) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    try {
        $cmd = Get-Command openssl.exe -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    } catch {}
    return $null
}

<#
    Read back what is actually on disk: fingerprint, expiry, whether it is
    self-signed, and its SANs. NEVER THROWS — every field is null/false when the
    file cannot be read or parsed, and a caller that cannot read a certificate
    must not conclude anything about it beyond "could not read".

    ⛔ ONLY THE FIRST CERTIFICATE BLOCK IS HASHED. An operator-supplied
    TLS_CERT_PATH is usually leaf + chain, and stripping every BEGIN/END marker
    from the whole file (which is what Get-WsTlsFingerprint in the installer
    does — safe there, because it only ever reads its own single-cert output)
    would concatenate the base64 of every certificate in the file and hash
    something that is not a certificate at all. The leaf is the first block.

    ⛔ The fingerprint is SHA-256 over the DER, rendered upper-case and
    colon-separated. That is byte-identical to node's
    tls.getPeerCertificate().fingerprint256 and to what openssl -fingerprint
    prints, which is what the agent's pin compares against (colons and case are
    ignored on its side).
#>
function Get-NocVaultCertInfo {
    param([Parameter(Mandatory = $true)][string]$CertPath)

    $info = [pscustomobject]@{
        Ok          = $false
        Fingerprint = $null
        NotAfter    = $null
        Subject     = $null
        Issuer      = $null
        SelfSigned  = $false
        SanText     = $null
        Error       = $null
    }
    try {
        if (-not (Test-Path -LiteralPath $CertPath)) {
            $info.Error = "not found: $CertPath"
            return $info
        }
        # -Encoding UTF8 on purpose. PEM is ASCII, so this cannot change the
        # bytes we care about, and Get-Content's default on 5.1 is the ANSI
        # codepage — the round-trip trap SecVault's CLAUDE.md records.
        $pem = Get-Content -LiteralPath $CertPath -Raw -Encoding UTF8
        if (-not $pem) {
            $info.Error = "empty: $CertPath"
            return $info
        }
        $m = [regex]::Match($pem, '(?s)-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----')
        if (-not $m.Success) {
            $info.Error = "no PEM certificate block in $CertPath"
            return $info
        }
        $b64 = ($m.Groups[1].Value -replace '\s', '')
        $der = [Convert]::FromBase64String($b64)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $info.Fingerprint = (($sha.ComputeHash($der) | ForEach-Object { $_.ToString('X2') }) -join ':')
        } finally {
            $sha.Dispose()
        }
        # The leading comma forces the byte[] overload; without it PowerShell
        # unrolls the array and looks for a constructor taking a single byte.
        $x = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, [byte[]]$der)
        $info.NotAfter = $x.NotAfter
        $info.Subject  = $x.Subject
        $info.Issuer   = $x.Issuer
        # Subject == Issuer is the honest test for "nothing will ever chain this
        # to a trusted root", and it is deliberately NOT "did this run mint it":
        # a re-install reuses the certificate it minted last time, so a
        # created-this-run flag would stop reporting a self-signed certificate
        # as self-signed on every subsequent run.
        $info.SelfSigned = ($x.Subject -eq $x.Issuer)
        $info.SanText = (($x.Extensions |
            Where-Object { $_.Oid.Value -eq '2.5.29.17' } |
            ForEach-Object { $_.Format($false) }) -join ' ')
        $info.Ok = $true
    } catch {
        $info.Error = $_.Exception.Message
    }
    return $info
}

<#
    Mint nocvault.crt / nocvault.key under $CertDir if they are not already
    there, and report the resulting fingerprint either way.

    ⛔ AN EXISTING CERTIFICATE IS NEVER OVERWRITTEN. The first act of this
    function is to succeed WITHOUT recreating anything when both files are
    present. That is the whole reason an operator's real corporate certificate
    survives every re-run of the installer: a silent replacement would turn a
    working, trusted console into a browser warning on a schedule nobody chose.
    Do not weaken it.

    ⛔ HALF A PAIR IS REFUSED, NOT COMPLETED. If exactly one of the two files
    exists, this does nothing and says why. Writing the missing half would
    produce a certificate and a key that do not match each other: both parse
    perfectly, and the terminator then reports transport state 'failed' at
    startup (or, worse, an operator who dropped in a certificate and had not yet
    copied the key finds a key they never generated sitting beside it).

    ⛔ SANs ARE MANDATORY, NOT DECORATION. Every current browser ignores the CN
    completely and validates against subjectAltName only, so a certificate with
    no SANs is REJECTED outright rather than merely untrusted. Both the IP and
    the names go in, because the consoles are reached by both — and so is the
    hub's agent control plane on 3000.

    ⛔ NEVER THROWS. A certificate that cannot be minted must degrade to "no TLS
    configured" — byte-for-byte the plain-HTTP install this suite has always
    shipped — and never abort an install that is otherwise fine.
#>
function New-NocVaultCertificate {
    param(
        [Parameter(Mandatory = $true)][string]$CertDir,
        [Parameter(Mandatory = $true)][string]$ServerIp,
        # The hostname users actually type (-TlsPublicHost), when there is one.
        # It must be in the SAN or the browser rejects the certificate on the
        # one address the operator chose to publish.
        [string]$PublicHost = '',
        # ⛔ 3650 DAYS. A self-signed certificate that expires turns a working
        # console into a browser wall on a date nobody has written down, and
        # there is no renewal process on a customer's on-premises box. An
        # operator who replaces this with a real certificate chooses their own
        # lifetime. (The agent-ingest certificates in the installer use 5 years
        # because a new key there breaks every already-pinned agent, which is a
        # different trade: here a replacement is a browser warning, not a fleet
        # outage.)
        [int]$Days = 3650
    )

    $res = [pscustomobject]@{
        CertPath    = (Join-Path $CertDir 'nocvault.crt')
        KeyPath     = (Join-Path $CertDir 'nocvault.key')
        Success     = $false
        Created     = $false
        Fingerprint = $null
        NotAfter    = $null
        SelfSigned  = $false
        SanParts    = @()
        Message     = ''
        Error       = $null
    }

    try {
        $certThere = Test-Path -LiteralPath $res.CertPath
        $keyThere  = Test-Path -LiteralPath $res.KeyPath

        # ---- never overwrite -------------------------------------------------
        if ($certThere -and $keyThere) {
            $res.Success = $true
            $res.Message = 'Existing certificate pair left untouched.'
            $info = Get-NocVaultCertInfo $res.CertPath
            if ($info.Ok) {
                $res.Fingerprint = $info.Fingerprint
                $res.NotAfter    = $info.NotAfter
                $res.SelfSigned  = $info.SelfSigned
            }
            return $res
        }
        if ($certThere -or $keyThere) {
            $present = $res.KeyPath
            $absent  = $res.CertPath
            if ($certThere) { $present = $res.CertPath; $absent = $res.KeyPath }
            $res.Error = "Only half a certificate pair is present ($present exists, $absent does not). Nothing was generated: writing the missing half would produce a certificate and key that do not match. Complete the pair or remove the odd file, then re-run."
            return $res
        }

        # ---- openssl ---------------------------------------------------------
        $openssl = Find-NocVaultOpenSsl
        if (-not $openssl) {
            $res.Error = 'openssl.exe not found (looked in Git for Windows, PostgreSQL and PATH). No certificate was generated.'
            return $res
        }

        New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

        # ---- names -----------------------------------------------------------
        $hostName = $env:COMPUTERNAME
        $fqdn     = $hostName
        try {
            $ipProps = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
            if ($ipProps.DomainName) { $fqdn = "$hostName.$($ipProps.DomainName)" }
        } catch {
            # Not domain-joined, or the lookup failed. The short name is still
            # a perfectly good SAN entry; this is not an error.
            $fqdn = $hostName
        }

        $dnsNames = @()
        $ipNames  = @()
        $pub = $PublicHost
        if ($pub) { $pub = $pub.Trim() }

        # Helper-free de-duplication: these lists are three or four entries long
        # and -notcontains on PowerShell arrays is already case-insensitive for
        # strings, which is the comparison DNS names need anyway.
        foreach ($d in @($hostName, $fqdn, 'localhost')) {
            if ($d -and ($dnsNames -notcontains $d)) { $dnsNames += $d }
        }
        $ipNames += '127.0.0.1'
        $parsed = $null
        if ($ServerIp -and [System.Net.IPAddress]::TryParse($ServerIp, [ref]$parsed)) {
            if ($ipNames -notcontains $ServerIp) { $ipNames += $ServerIp }
        }
        # -TlsPublicHost may be either a name or an address, so it is CLASSIFIED
        # rather than assumed: an IP written into a DNS SAN entry does not match
        # a browser dialling that IP, and vice versa.
        if ($pub) {
            if ([System.Net.IPAddress]::TryParse($pub, [ref]$parsed)) {
                if ($ipNames -notcontains $pub) { $ipNames += $pub }
            } else {
                if ($dnsNames -notcontains $pub) { $dnsNames += $pub }
            }
        }

        # The CN is set to the most public name available even though nothing
        # validates it any more, so that the certificate reads sensibly in a
        # browser's details pane and in Settings.
        $cn = $ServerIp
        if ($pub) { $cn = $pub } elseif ($fqdn -ne $hostName) { $cn = $fqdn }

        $altLines = @()
        $i = 1
        foreach ($d in $dnsNames) { $altLines += ("DNS.$i = $d"); $i++ }
        $i = 1
        foreach ($a in $ipNames)  { $altLines += ("IP.$i = $a");  $i++ }

        $sanParts = @()
        foreach ($d in $dnsNames) { $sanParts += "DNS:$d" }
        foreach ($a in $ipNames)  { $sanParts += "IP:$a" }
        $res.SanParts = $sanParts

        # ---- openssl config --------------------------------------------------
        # ⛔ A CONFIG FILE, NOT -subj/-addext. This mirrors the installer's own
        # New-WsTlsCert and diverges from SecVault's port on purpose: a
        # leading-slash -subj argument can be path-mangled by an MSYS-linked
        # openssl (which is exactly what Git for Windows ships), and -addext
        # needs OpenSSL >= 1.1.1. A config file needs neither.
        $cfg = Join-Path $env:TEMP ("nocvault-terminator-{0}.cnf" -f ([guid]::NewGuid().ToString('N')))
        $cfgText = @"
[ req ]
default_bits       = 2048
default_md         = sha256
prompt             = no
distinguished_name = nv_dn
x509_extensions    = nv_ext

[ nv_dn ]
CN = $cn
O  = NocVault

[ nv_ext ]
basicConstraints = critical,CA:FALSE
keyUsage         = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName   = @nv_alt

[ nv_alt ]
$($altLines -join "`n")
"@
        [System.IO.File]::WriteAllText($cfg, $cfgText, (New-Object System.Text.UTF8Encoding($false)))

        # ⛔ SUCCESS IS JUDGED BY THE EXIT CODE AND THE FILES ON DISK, NEVER BY
        # $? OR BY AN EXCEPTION. openssl streams its key-generation progress
        # ('+++++') to STDERR; under $ErrorActionPreference = 'Stop' a host that
        # merges a native command's stderr into PowerShell's error stream turns
        # a perfectly successful keygen into a thrown "OpenSSL failed" whose
        # message is the progress dots. SecVault shipped exactly that bug.
        $prevEap = $ErrorActionPreference
        $code    = 0
        try {
            $ErrorActionPreference = 'Continue'
            # NOT $args — that is PowerShell's automatic arguments variable.
            $sslArgs = @(
                'req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
                '-days', "$Days",
                '-config', $cfg,
                '-keyout', $res.KeyPath,
                '-out', $res.CertPath
            )
            # Assign, then test. PS 5.1 cannot pipe straight out of a try block.
            $null = & $openssl @sslArgs 2>&1
            $code = $LASTEXITCODE
        } catch {
            $res.Error = "openssl could not be run: $($_.Exception.Message)"
            return $res
        } finally {
            $ErrorActionPreference = $prevEap
            Remove-Item -LiteralPath $cfg -Force -ErrorAction SilentlyContinue
        }

        if (-not ((Test-Path -LiteralPath $res.CertPath) -and (Test-Path -LiteralPath $res.KeyPath))) {
            $res.Error = "openssl exited with code $code and did not produce $($res.CertPath) / $($res.KeyPath). No certificate was generated."
            return $res
        }

        $res.Created = $true

        # ⛔ The key is an UNENCRYPTED private key on disk and it is the whole
        # secret. /inheritance:r FIRST, so ProgramData's inherited
        # BUILTIN\Users read ACE is actually removed rather than merely
        # supplemented — the same mistake that left the suite's secrets.env
        # world-readable on the production server. Well-known SIDs, never the
        # English account names, which do not resolve on a localised Windows.
        #   S-1-5-18     Local System — the account the NSSM services run as
        #   S-1-5-32-544 the local Administrators group
        # Best-effort: the certificate works either way, so a failure here is
        # reported, never fatal.
        try {
            & icacls.exe $res.KeyPath /inheritance:r /grant '*S-1-5-18:(R)' /grant '*S-1-5-32-544:(F)' | Out-Null
        } catch {
            $res.Message = 'NOTE: could not tighten the ACL on the private key.'
        }

        $info = Get-NocVaultCertInfo $res.CertPath
        if ($info.Ok) {
            $res.Fingerprint = $info.Fingerprint
            $res.NotAfter    = $info.NotAfter
            $res.SelfSigned  = $info.SelfSigned
        }
        $res.Success = $true
        $mintMsg = "Self-signed certificate created for $($sanParts -join ', ')"
        if ($res.Message) { $res.Message = "$mintMsg ($($res.Message))" } else { $res.Message = $mintMsg }
    } catch {
        $res.Error = $_.Exception.Message
    }
    return $res
}
