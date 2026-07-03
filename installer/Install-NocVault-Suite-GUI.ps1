<#
================================================================
  NocVault Suite - Graphical Installer (WPF wrapper)   [PROTOTYPE]
  ---------------------------------------------------------------
  A Windows-style setup window (config form + progress bar + live
  log) that DRIVES the existing Install-NocVault-Suite.ps1 in the
  background with -Unattended, so there is no console and no prompts.

  Run directly for testing:
      powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-NocVault-Suite-GUI.ps1

  Ship as a no-console .exe with:  .\Build-Setup-Exe.ps1
  (compiles this file with ps2exe -> NocVault-Suite-Setup.exe)
================================================================
#>
[CmdletBinding()]
param()

# Resolve our own path/folder whether running as a .ps1 or a compiled ps2exe .exe
# (compiled: $PSCommandPath/$PSScriptRoot are EMPTY -> use the process image path).
$SelfPath = if ($PSCommandPath) { $PSCommandPath }
            elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path }
            else { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }
$ScriptDir = Split-Path -Parent $SelfPath
$Compiled  = [string]::IsNullOrEmpty($PSCommandPath)

# ---------- self-elevate (hidden) ----------
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    try {
        if ($Compiled) {
            Start-Process -FilePath $SelfPath -Verb RunAs
        } else {
            Start-Process -FilePath (Get-Process -Id $PID).Path `
                -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","`"$SelfPath`"" -Verb RunAs
        }
    } catch { }
    exit
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

# ---------- locate the real installer next to this file ----------
$InstallerPs1 = Join-Path $ScriptDir 'Install-NocVault-Suite.ps1'

# ---------- launch helpers -------------------------------------------------
# Always drive the engine with the REAL powershell.exe (NOT our own image, which
# is the .exe when compiled). Bools/switches/passwords are baked into a tiny
# wrapper .ps1 and run with -File, so nothing has to bind through the command line.
$PoshExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path $PoshExe)) { $PoshExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
function Q([string]$s) { "'" + ($s -replace "'","''") + "'" }   # PS single-quote + escape apostrophes
function Start-EngineWorker([string]$innerCmd) {
    # persistent log on the Desktop (fallback TEMP) so it can be shared for support
    $logDir = [Environment]::GetFolderPath('Desktop')
    if (-not $logDir -or -not (Test-Path $logDir)) { $logDir = $env:TEMP }
    $script:logFile = Join-Path $logDir ($script:logName + '.log')
    try { Set-Content -LiteralPath $script:logFile -Value ("NocVault Suite - $($script:logName)`r`n$(Get-Date)`r`n" + ('=' * 60)) -Encoding UTF8 } catch { $script:logFile = $null }
    $script:wrapper = Join-Path $env:TEMP ('nocvault_' + [guid]::NewGuid().ToString('N') + '.ps1')
    # Success = COMPLETION, not $LASTEXITCODE. The engine .ps1 ends without a clean
    # 'exit 0' and native tools (npm/nssm/sc) leave a non-zero $LASTEXITCODE even on a
    # successful run, so keying on the exit code gave false "failed" results. A real
    # engine failure THROWS (e.g. 'SpanVault frontend build failed') -> caught -> exit 1.
    $body = "`$ErrorActionPreference='Continue'`r`ntry {`r`n" + $innerCmd + "`r`n  exit 0`r`n} catch {`r`n  Write-Host ('FATAL: ' + `$_.Exception.Message)`r`n  exit 1`r`n}`r`n"
    Set-Content -LiteralPath $script:wrapper -Value $body -Encoding UTF8
    $script:outFile = [System.IO.Path]::GetTempFileName()
    $script:errFile = [System.IO.Path]::GetTempFileName()
    return (Start-Process -FilePath $PoshExe -PassThru -WindowStyle Hidden `
        -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$script:wrapper`"") `
        -RedirectStandardOutput $script:outFile -RedirectStandardError $script:errFile)
}

# ---------- auto-detect a server IP (same rule as the smoke tester) ----------
$DetectedIP = try {
    (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
} catch { '' }
if (-not $DetectedIP) { $DetectedIP = '127.0.0.1' }

# ================================================================
#  XAML  (NocVault suite palette: navy #1A2744 header, TU-red #C8102E)
# ================================================================
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="NocVault Suite Setup" Height="620" Width="760"
        WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize"
        Background="#F4F6F9" FontFamily="Segoe UI">
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="72"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="64"/>
    </Grid.RowDefinitions>

    <!-- header -->
    <Border Grid.Row="0" Background="#1A2744">
      <StackPanel Orientation="Vertical" VerticalAlignment="Center" Margin="20,0">
        <TextBlock Text="NocVault Suite" Foreground="White" FontSize="20" FontWeight="SemiBold"/>
        <TextBlock Text="Network Intelligence Suite - Installer" Foreground="#9FB0C9" FontSize="12"/>
      </StackPanel>
    </Border>

    <!-- body -->
    <Grid Grid.Row="1" Margin="20,16,20,8">
      <!-- CONFIG panel -->
      <StackPanel x:Name="ConfigPanel">
        <TextBlock Text="Install location" FontWeight="SemiBold" Margin="0,0,0,4"/>
        <TextBox x:Name="TxtInstallDir" Text="C:\Apps" Height="28" Padding="6,4" Margin="0,0,0,12"/>

        <TextBlock Text="Server IP address" FontWeight="SemiBold" Margin="0,0,0,4"/>
        <TextBox x:Name="TxtServerIP" Height="28" Padding="6,4" Margin="0,0,0,12"/>

        <TextBlock Text="Components (NetVault hub is always installed)" FontWeight="SemiBold" Margin="0,0,0,6"/>
        <StackPanel Orientation="Horizontal" Margin="0,0,0,12">
          <CheckBox x:Name="ChkLog"  Content="LogVault"  IsChecked="True" Margin="0,0,20,0"/>
          <CheckBox x:Name="ChkDdi"  Content="DDIVault"  IsChecked="True" Margin="0,0,20,0"/>
          <CheckBox x:Name="ChkSpan" Content="SpanVault" IsChecked="True"/>
        </StackPanel>

        <CheckBox x:Name="ChkDefaults" Content="Use default database passwords (change after install)" IsChecked="True" Margin="0,0,0,10"/>
        <Grid x:Name="PwGrid">
          <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="16"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
          <StackPanel Grid.Column="0">
            <TextBlock Text="PostgreSQL 'postgres' password" FontSize="12" Margin="0,0,0,4"/>
            <PasswordBox x:Name="PwPg" Height="28" Padding="6,4"/>
          </StackPanel>
          <StackPanel Grid.Column="2">
            <TextBlock Text="NocVault read-only role password" FontSize="12" Margin="0,0,0,4"/>
            <PasswordBox x:Name="PwRo" Height="28" Padding="6,4"/>
          </StackPanel>
        </Grid>

        <Border Background="#FFF7E6" BorderBrush="#F0C36D" BorderThickness="1" CornerRadius="6" Padding="10" Margin="0,16,0,0">
          <TextBlock TextWrapping="Wrap" Foreground="#8A6D3B" FontSize="12"
            Text="Internet access is required (the suite is cloned from GitHub). Node.js, Git and PostgreSQL 16 are installed automatically if missing. Estimated time: 15-20 minutes."/>
        </Border>
      </StackPanel>

      <!-- PROGRESS panel (hidden until install starts) -->
      <StackPanel x:Name="ProgressPanel" Visibility="Collapsed">
        <TextBlock x:Name="LblStep" Text="Preparing..." FontSize="15" FontWeight="SemiBold" Margin="0,0,0,8"/>
        <ProgressBar x:Name="Bar" Height="22" Minimum="0" Maximum="100" Value="0" Foreground="#C8102E"/>
        <TextBlock x:Name="LblPct" Text="0%" FontSize="12" Foreground="#64748B" Margin="0,4,0,10"/>
        <Border Background="#0D1220" CornerRadius="6" Padding="2">
          <TextBox x:Name="TxtLog" Height="300" Background="#0D1220" Foreground="#CBD5E1"
                   FontFamily="Consolas" FontSize="12" BorderThickness="0"
                   IsReadOnly="True" VerticalScrollBarVisibility="Auto" TextWrapping="NoWrap"/>
        </Border>
      </StackPanel>
    </Grid>

    <!-- footer buttons -->
    <Border Grid.Row="2" Background="#FFFFFF" BorderBrush="#E2E8F0" BorderThickness="0,1,0,0">
      <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center" Margin="0,0,20,0">
        <TextBlock x:Name="LblStatus" Text="" VerticalAlignment="Center" Foreground="#64748B" Margin="0,0,16,0"/>
        <Button x:Name="BtnCancel" Content="Cancel" Width="90" Height="32" Margin="0,0,10,0"/>
        <Button x:Name="BtnInstall" Content="Install" Width="120" Height="32"
                Background="#C8102E" Foreground="White" BorderThickness="0" FontWeight="SemiBold"/>
      </StackPanel>
    </Border>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$win    = [Windows.Markup.XamlReader]::Load($reader)

# taskbar progress (the fill on the taskbar button), synced to the ProgressBar below
$win.TaskbarItemInfo = New-Object System.Windows.Shell.TaskbarItemInfo

# ---------- grab named elements ----------
$el = @{}
'ConfigPanel','TxtInstallDir','TxtServerIP','ChkLog','ChkDdi','ChkSpan','ChkDefaults','PwGrid','PwPg','PwRo',
'ProgressPanel','LblStep','Bar','LblPct','TxtLog','LblStatus','BtnCancel','BtnInstall' | ForEach-Object {
    $el[$_] = $win.FindName($_)
}
$el.TxtServerIP.Text = $DetectedIP
$el.Bar.Add_ValueChanged({ try { $win.TaskbarItemInfo.ProgressValue = ([double]$el.Bar.Value / 100) } catch {} })

# toggle password boxes with the "use defaults" checkbox
$togglePw = { $el.PwGrid.IsEnabled = -not $el.ChkDefaults.IsChecked }
$el.ChkDefaults.Add_Checked($togglePw); $el.ChkDefaults.Add_Unchecked($togglePw); & $togglePw

# ---------- shared run state ----------
$script:proc    = $null
$script:timer   = $null
$script:outFile = $null
$script:errFile = $null
$script:wrapper = $null
$script:logFile = $null
$script:logName = 'NocVault-Suite-Setup'
$script:seen    = 0
$script:step    = 0
$script:total   = 14

function Append-Log($text, $color) {
    $el.TxtLog.AppendText($text + "`r`n")
    $el.TxtLog.ScrollToEnd()
    if ($script:logFile) { try { Add-Content -LiteralPath $script:logFile -Value $text -Encoding UTF8 } catch {} }
}

function Finish($ok, $msg) {
    if ($script:timer) { $script:timer.Stop() }
    $el.Bar.Value = 100
    $el.LblPct.Text = '100%'
    $el.LblStep.Text = if ($ok) { 'Installation complete' } else { 'Installation failed' }
    $el.LblStatus.Text = $msg
    $el.LblStatus.Foreground = if ($ok) { '#15803D' } else { '#B91C1C' }
    $el.BtnInstall.IsEnabled = $false
    $el.BtnCancel.Content = 'Close'
    $el.BtnCancel.IsEnabled = $true
    try { $win.TaskbarItemInfo.ProgressState = if ($ok) { 'Normal' } else { 'Error' } } catch {}
    if ($script:logFile) {
        $el.TxtLog.AppendText("`r`nFull log saved to: $($script:logFile)`r`n"); $el.TxtLog.ScrollToEnd()
        if (-not $ok) { try { Start-Process notepad.exe $script:logFile } catch {} }
    }
}

# ---------- Install click ----------
$el.BtnInstall.Add_Click({
    if (-not (Test-Path $InstallerPs1)) {
        [System.Windows.MessageBox]::Show("Install-NocVault-Suite.ps1 was not found next to this installer:`n$InstallerPs1",
            'NocVault Suite Setup','OK','Error') | Out-Null
        return
    }

    $installDir = $el.TxtInstallDir.Text.Trim()
    $serverIP   = $el.TxtServerIP.Text.Trim()
    $useDefault = [bool]$el.ChkDefaults.IsChecked
    $pgPass     = $el.PwPg.Password
    $roPass     = $el.PwRo.Password
    if (-not $useDefault -and ([string]::IsNullOrWhiteSpace($pgPass) -or [string]::IsNullOrWhiteSpace($roPass))) {
        [System.Windows.MessageBox]::Show('Enter both database passwords, or tick "Use default database passwords".',
            'NocVault Suite Setup','OK','Warning') | Out-Null
        return
    }

    # progress total = 14 steps minus any unselected optional apps
    $script:total = 14
    if (-not $el.ChkLog.IsChecked)  { $script:total-- }
    if (-not $el.ChkDdi.IsChecked)  { $script:total-- }
    if (-not $el.ChkSpan.IsChecked) { $script:total-- }

    # build the installer command: bools as real $true/$false, strings single-quoted
    $cmd  = "& $(Q $InstallerPs1) -Unattended -InstallDir $(Q $installDir) -ServerIP $(Q $serverIP)"
    $cmd += ' -InstallLogVault:'  + $(if ($el.ChkLog.IsChecked)  { '$true' } else { '$false' })
    $cmd += ' -InstallDDIVault:'  + $(if ($el.ChkDdi.IsChecked)  { '$true' } else { '$false' })
    $cmd += ' -InstallSpanVault:' + $(if ($el.ChkSpan.IsChecked) { '$true' } else { '$false' })
    if (-not $useDefault) { $cmd += " -PgAdminPassword $(Q $pgPass) -NocReadOnlyPass $(Q $roPass)" }

    # swap panels
    $el.ConfigPanel.Visibility = 'Collapsed'
    $el.ProgressPanel.Visibility = 'Visible'
    $el.BtnInstall.IsEnabled = $false
    $el.LblStatus.Text = 'Installing...'
    try { $win.TaskbarItemInfo.ProgressState = 'Normal' } catch {}
    $script:seen = 0; $script:step = 0

    try {
        $script:proc = Start-EngineWorker $cmd
    } catch {
        Finish $false "Could not start installer: $($_.Exception.Message)"
        return
    }

    # poll the output files on the UI thread
    $script:timer = New-Object System.Windows.Threading.DispatcherTimer
    $script:timer.Interval = [TimeSpan]::FromMilliseconds(350)
    $script:timer.Add_Tick({
        foreach ($f in @($script:outFile, $script:errFile)) {
            if (-not (Test-Path $f)) { continue }
        }
        $lines = @()
        try { $lines = Get-Content -LiteralPath $script:outFile -ErrorAction SilentlyContinue } catch {}
        if ($lines.Count -gt $script:seen) {
            for ($i = $script:seen; $i -lt $lines.Count; $i++) {
                $ln = $lines[$i]
                if ($ln -match '^\s*==>\s*(.+?)\s*$') {
                    $script:step++
                    $el.LblStep.Text = ("Step {0} of {1}: {2}" -f $script:step, $script:total, $Matches[1])
                    $pct = [math]::Min(95, [int](($script:step / [math]::Max(1,$script:total)) * 100))
                    $el.Bar.Value = $pct; $el.LblPct.Text = "$pct%"
                }
                Append-Log $ln
            }
            $script:seen = $lines.Count
        }
        if ($script:proc.HasExited) {
            # drain stderr: keep full detail in the log file, but don't flood the pane
            # with psql NOTICEs / npm warnings / NativeCommandError noise - show a summary.
            try {
                $errLines = @(Get-Content -LiteralPath $script:errFile -ErrorAction SilentlyContinue)
                if ($errLines.Count) {
                    if ($script:logFile) { foreach ($e in $errLines) { try { Add-Content -LiteralPath $script:logFile -Value "[stderr] $e" -Encoding UTF8 } catch {} } }
                    Append-Log "  ($($errLines.Count) diagnostic/stderr lines hidden - full detail in the saved log)"
                }
            } catch {}
            Remove-Item $script:outFile,$script:errFile,$script:wrapper -ErrorAction SilentlyContinue
            if ($script:proc.ExitCode -eq 0) {
                Finish $true  "Suite installed. Open http://$($el.TxtServerIP.Text.Trim()):3000"
            } else {
                Finish $false "Installer exited with code $($script:proc.ExitCode). See log above."
            }
        }
    })
    $script:timer.Start()
})

# ---------- Cancel / Close ----------
$el.BtnCancel.Add_Click({
    if ($script:proc -and -not $script:proc.HasExited) {
        $r = [System.Windows.MessageBox]::Show('Installation is running. Stop it now? The system may be left half-installed.',
            'NocVault Suite Setup','YesNo','Warning')
        if ($r -ne 'Yes') { return }
        try { $script:proc.Kill() } catch {}
        if ($script:timer) { $script:timer.Stop() }
    }
    $win.Close()
})

$win.ShowDialog() | Out-Null
