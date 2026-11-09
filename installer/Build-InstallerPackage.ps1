<#
.SYNOPSIS
    Assemble NocVault-Suite-Installer-<version>.zip - the thing a customer is given.

.DESCRIPTION
    Until this existed the distribution zip was assembled BY HAND, which is why
    CLAUDE.md said "there is NO packaging script in any repo - the zip is
    assembled by hand". Hand assembly is how a stale .exe, or a missing engine
    .ps1, reaches a customer: the exe is a thin GUI shell that drives its sibling
    .ps1, so a zip holding one without the other produces an installer that
    launches and then fails on the target machine.

    This script collects the engines, the GUI exes, the demo seeds and the
    offline dependency binaries, VERIFIES the set, and zips it. It refuses to
    build an incomplete package rather than producing one that fails later on
    someone else's server.

    ⛔ IT DOES NOT BUILD THE EXES. They are ps2exe artifacts and must be built on
    Windows (Build-Setup-Exe.ps1, -STA). This script only checks they are present
    and warns when one is older than the .ps1 it wraps - the "stale exe" case
    CLAUDE.md calls the usual reason a fix "still fails" on a target machine.

.PARAMETER OutDir
    Where to write the .zip. Defaults to the repo's dist\ folder.

.PARAMETER SkipDependencies
    Build a SMALL package with no dependencies\ folder. Only for a machine that
    already has Node 22+, Git, NSSM, VC++ and PostgreSQL 16.

.PARAMETER AllowMissingExe
    Build anyway when a GUI .exe is absent. The package is then .ps1-only: usable
    from a PowerShell prompt, NOT by double-click.

.EXAMPLE
    .\Build-InstallerPackage.ps1
    .\Build-InstallerPackage.ps1 -SkipDependencies
#>
param(
    [string]$OutDir = "",
    [switch]$SkipDependencies,
    [switch]$AllowMissingExe
)

$ErrorActionPreference = 'Stop'

function Say($m)  { Write-Host "  $m" -ForegroundColor Gray }
function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`n  [FATAL] $m`n" -ForegroundColor Red; exit 1 }
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$RepoRoot  = Split-Path -Parent $ScriptDir
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'dist' }

# The version a customer sees is NetVault's - it is the hub and the only app
# whose installer lives here.
$pkgJson = Join-Path $RepoRoot 'package.json'
if (-not (Test-Path -LiteralPath $pkgJson)) { Die "package.json not found at $pkgJson" }
$Version = (Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json).version

Write-Host ""
Write-Host "  +==================================================+" -ForegroundColor Cyan
Write-Host "  |  NocVault Suite - installer package builder      |" -ForegroundColor Cyan
Write-Host "  +==================================================+" -ForegroundColor Cyan
Say "source   : $ScriptDir"
Say "version  : $Version (from netvault package.json)"
Say "output   : $OutDir"

# ── what goes in ────────────────────────────────────────────────────────────
# ⛔ Install-NocVault-Suite.ps1 DOT-SOURCES its siblings (NocVault-Tls.ps1,
# NocVault-TlsPreflight.ps1, NocVault-TlsCutover.ps1) from its own folder. Ship
# the engine without them and TLS silently degrades to "certificate helper
# missing" on a customer install, so they are REQUIRED, not optional.
$RequiredPs1 = @(
    'Install-NocVault-Suite.ps1',
    'Uninstall-NocVault-Suite.ps1',
    'Test-NocVault-Suite.ps1',
    'Install-NocVault-Suite-GUI.ps1',
    'Uninstall-NocVault-Suite-GUI.ps1',
    'Test-NocVault-Suite-GUI.ps1',
    'NocVault-Tls.ps1',
    'NocVault-TlsPreflight.ps1',
    'NocVault-TlsCutover.ps1',
    'Enable-NocVaultTls.ps1',
    'NocVault-Demo-Seed-GUI.ps1'
)
$OptionalPs1 = @('Update-NetVault.ps1', 'Install-NetVault.ps1', 'Uninstall-NetVault.ps1', 'README.txt',
                 'Install-NocVault.cmd', 'Uninstall-NocVault.cmd', 'Test-NocVault-Suite.cmd', 'nocvault.ico')

# exe -> the .ps1 it wraps, so a stale exe can be reported against its engine.
$ExePairs = @{
    'NocVault-Suite-Setup.exe'     = 'Install-NocVault-Suite-GUI.ps1'
    'NocVault-Suite-Uninstall.exe' = 'Uninstall-NocVault-Suite-GUI.ps1'
    'NocVault-Suite-Test.exe'      = 'Test-NocVault-Suite-GUI.ps1'
    'NocVault-Demo-Seed.exe'       = 'NocVault-Demo-Seed-GUI.ps1'
}

# Offline dependency set. Node 22 is a HARD requirement, not a preference: the
# TLS terminator imports a TypeScript module and node executes TS unflagged only
# from 22.18 - see $NodeRequired in Install-NocVault-Suite.ps1. Node 20 is EOL.
$DepSpecs = @(
    @{ Pattern = 'node-v22.*-x64.msi';            What = 'Node.js 22 LTS (>= 22.18.0)';  Required = $true  },
    @{ Pattern = 'nssm-2.24.zip';                 What = 'NSSM 2.24 service manager';    Required = $true  },
    @{ Pattern = 'postgresql-16*windows-x64.exe'; What = 'PostgreSQL 16';                Required = $true  },
    @{ Pattern = 'Git-*-64-bit.exe';              What = 'Git for Windows';              Required = $false },
    @{ Pattern = 'VC_redist.x64.exe';             What = 'VC++ 2015-2022 redistributable'; Required = $false }
)

# ── collect ─────────────────────────────────────────────────────────────────
Step "Collecting engine scripts"
$missing = @()
foreach ($f in $RequiredPs1) {
    if (Test-Path -LiteralPath (Join-Path $ScriptDir $f)) { Ok $f } else { $missing += $f; Warn "MISSING $f" }
}
if ($missing.Count -gt 0) { Die ("required script(s) missing: " + ($missing -join ', ')) }

Step "Checking GUI executables"
$exeMissing = @()
foreach ($exe in $ExePairs.Keys) {
    $exePath = Join-Path $ScriptDir $exe
    if (-not (Test-Path -LiteralPath $exePath)) { $exeMissing += $exe; Warn "MISSING $exe (build it with Build-Setup-Exe.ps1 -STA on Windows)"; continue }
    $src = Join-Path $ScriptDir $ExePairs[$exe]
    if (Test-Path -LiteralPath $src) {
        $exeTime = (Get-Item -LiteralPath $exePath).LastWriteTime
        $srcTime = (Get-Item -LiteralPath $src).LastWriteTime
        if ($srcTime -gt $exeTime) {
            # ⛔ The single most common "but I fixed that" report: the engine .ps1
            # changed and the GUI shell wrapping it was never rebuilt.
            Warn ("$exe is OLDER than $($ExePairs[$exe]) - rebuild it, or ship a known-stale GUI")
        } else { Ok ("$exe (newer than its .ps1)") }
    } else { Ok $exe }
}
if ($exeMissing.Count -gt 0 -and -not $AllowMissingExe) {
    Die ("GUI exe(s) missing: " + ($exeMissing -join ', ') + ".`n  Build them on Windows with Build-Setup-Exe.ps1 (-STA), or pass -AllowMissingExe for a .ps1-only package.")
}

Step "Checking seed scripts"
$seedDir = Join-Path $ScriptDir 'seeds'
if (-not (Test-Path -LiteralPath $seedDir)) { Die "seeds\ not found - the demo seeder cannot work without it" }
$seeds = @(Get-ChildItem -LiteralPath $seedDir -Filter '*-seed.js')
foreach ($app in @('netvault','logvault','ddivault','spanvault')) {
    if ($seeds.Name -contains "$app-seed.js") { Ok "seeds\$app-seed.js" } else { Warn "seeds\$app-seed.js MISSING" }
}

$depDir = Join-Path $ScriptDir 'dependencies'
$depFiles = @()
if ($SkipDependencies) {
    Step "Dependencies SKIPPED (-SkipDependencies)"
    Warn "The package will only install on a machine that already has Node 22+, NSSM, PostgreSQL 16, Git and VC++."
} else {
    Step "Checking offline dependencies"
    if (-not (Test-Path -LiteralPath $depDir)) { Die "dependencies\ not found. Populate it (see Get-Dependencies notes in the README) or pass -SkipDependencies." }
    $depMissing = @()
    foreach ($spec in $DepSpecs) {
        $hit = @(Get-ChildItem -LiteralPath $depDir -Filter $spec.Pattern -ErrorAction SilentlyContinue)
        if ($hit.Count -gt 0) {
            $depFiles += $hit
            Ok ("{0}: {1} ({2:N1} MB)" -f $spec.What, $hit[0].Name, ($hit[0].Length / 1MB))
        } elseif ($spec.Required) {
            $depMissing += ("{0}  [{1}]" -f $spec.Pattern, $spec.What)
            Warn ("MISSING " + $spec.Pattern + "  - " + $spec.What)
        } else {
            Warn ("absent (optional): " + $spec.Pattern + "  - " + $spec.What)
        }
    }
    if ($depMissing.Count -gt 0) { Die ("required dependency file(s) missing:`n    - " + ($depMissing -join "`n    - ")) }

    # The Node MSI must actually satisfy the floor the installer enforces.
    $nodeMsi = @(Get-ChildItem -LiteralPath $depDir -Filter 'node-v22.*-x64.msi')[0]
    if ($nodeMsi.Name -match '^node-v(\d+\.\d+\.\d+)-x64\.msi$') {
        $mv = [version]$Matches[1]
        if ($mv -lt [version]'22.18.0') { Die ("$($nodeMsi.Name) is older than the v22.18.0 floor the installer enforces - the TLS terminator needs unflagged TypeScript execution.") }
        Ok ("Node MSI v$mv satisfies the v22.18.0 floor")
    }
}

# ── stage ───────────────────────────────────────────────────────────────────
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage   = Join-Path ([IO.Path]::GetTempPath()) ("nocvault-pkg-" + $stamp)
# ⛔ THE -SkipDependencies VARIANT MUST NOT SHARE A FILENAME WITH THE REAL ONE.
# It did, and building the small one for a quick test SILENTLY OVERWROTE the
# 453 MB package built minutes earlier - same name, no warning, no prompt. A
# release artifact must not be destroyable by a test build.
$pkgName = "NocVault-Suite-Installer-$Version"
if ($SkipDependencies) { $pkgName = "$pkgName-nodeps" }
$pkgRoot = Join-Path $stage $pkgName
Step "Staging to $pkgRoot"
New-Item -ItemType Directory -Path $pkgRoot -Force | Out-Null

foreach ($f in ($RequiredPs1 + $OptionalPs1)) {
    $src = Join-Path $ScriptDir $f
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $pkgRoot -Force }
}
foreach ($exe in $ExePairs.Keys) {
    $src = Join-Path $ScriptDir $exe
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $pkgRoot -Force }
}
Copy-Item -LiteralPath $seedDir -Destination (Join-Path $pkgRoot 'seeds') -Recurse -Force
if (-not $SkipDependencies) {
    $pkgDeps = Join-Path $pkgRoot 'dependencies'
    New-Item -ItemType Directory -Path $pkgDeps -Force | Out-Null
    foreach ($d in $depFiles) { Copy-Item -LiteralPath $d.FullName -Destination $pkgDeps -Force }
}

# A manifest, so what shipped can be established later from the zip alone.
$manifest = @()
$manifest += "NocVault Suite installer package"
$manifest += "version   : $Version"
$manifest += "built     : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
# $env:COMPUTERNAME is Windows-only and this script also runs under pwsh on
# Linux to assemble the zip, where it is empty - leaving a blank line in the
# manifest that is meant to say where a package came from.
$builtOn = $env:COMPUTERNAME
if (-not $builtOn) { $builtOn = [System.Net.Dns]::GetHostName() }
if (-not $builtOn) { $builtOn = 'unknown' }
$manifest += "built on  : $builtOn"
$manifest += ""
$manifest += "contents (sha256):"
foreach ($f in (Get-ChildItem -LiteralPath $pkgRoot -Recurse -File | Sort-Object FullName)) {
    $rel = $f.FullName.Substring($pkgRoot.Length + 1)
    $h   = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    $manifest += ("  {0,-46} {1,12:N0} B  {2}" -f $rel, $f.Length, $h.Substring(0, 16))
}
$manifest | Set-Content -LiteralPath (Join-Path $pkgRoot 'PACKAGE-MANIFEST.txt') -Encoding ASCII

# ── zip ─────────────────────────────────────────────────────────────────────
Step "Creating the archive"
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$zipPath = Join-Path $OutDir "$pkgName.zip"
if (Test-Path -LiteralPath $zipPath) {
    $prev = Get-Item -LiteralPath $zipPath
    Warn ("replacing existing {0} ({1:N1} MB, built {2})" -f $prev.Name, ($prev.Length / 1MB), $prev.LastWriteTime)
    Remove-Item -LiteralPath $zipPath -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($pkgRoot, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue

$zi = Get-Item -LiteralPath $zipPath
Write-Host ""
Ok ("package : " + $zi.FullName)
Ok ("size    : {0:N1} MB" -f ($zi.Length / 1MB))
Ok ("sha256  : " + (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash)
Write-Host ""
Say "The zip contains ONE folder, $pkgName\, so it cannot explode over a desktop."
Say "On the target machine: extract, then run NocVault-Suite-Setup.exe as Administrator"
Say "(or Install-NocVault-Suite.ps1 from an elevated PowerShell)."
Write-Host ""
