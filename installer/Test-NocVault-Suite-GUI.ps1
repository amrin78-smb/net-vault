<#
================================================================
  NocVault Suite - Graphical Smoke Test (WPF wrapper)
  ---------------------------------------------------------------
  A Windows-style window that DRIVES Test-NocVault-Suite.ps1 in the
  background (no console), streaming its section headers and
  [ PASS ] / [ FAIL ] / [ WARN ] results into a live log with a
  running tally and a final pass/fail verdict.

  Test:   powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-NocVault-Suite-GUI.ps1
  Build:  .\Build-Setup-Exe.ps1   (-> NocVault-Suite-Test.exe)
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

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$TestPs1   = Join-Path $ScriptDir 'Test-NocVault-Suite.ps1'

# ---------- launch helpers: drive the engine via the REAL powershell.exe + a wrapper .ps1
$PoshExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path $PoshExe)) { $PoshExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
function Q([string]$s) { "'" + ($s -replace "'","''") + "'" }
function Start-EngineWorker([string]$innerCmd) {
    $logDir = [Environment]::GetFolderPath('Desktop')
    if (-not $logDir -or -not (Test-Path $logDir)) { $logDir = $env:TEMP }
    $script:logFile = Join-Path $logDir ($script:logName + '.log')
    try { Set-Content -LiteralPath $script:logFile -Value ("NocVault Suite - $($script:logName)`r`n$(Get-Date)`r`n" + ('=' * 60)) -Encoding UTF8 } catch { $script:logFile = $null }
    $script:wrapper = Join-Path $env:TEMP ('nocvault_' + [guid]::NewGuid().ToString('N') + '.ps1')
    # Success = COMPLETION, not $LASTEXITCODE (the engine ends without a clean 'exit 0').
    # The tester decides pass/fail from its own [ FAIL ] tally, not this exit code.
    $body = "`$ErrorActionPreference='Continue'`r`ntry {`r`n" + $innerCmd + "`r`n  exit 0`r`n} catch {`r`n  Write-Host ('FATAL: ' + `$_.Exception.Message)`r`n  exit 1`r`n}`r`n"
    Set-Content -LiteralPath $script:wrapper -Value $body -Encoding UTF8
    $script:outFile = [System.IO.Path]::GetTempFileName()
    $script:errFile = [System.IO.Path]::GetTempFileName()
    return (Start-Process -FilePath $PoshExe -PassThru -WindowStyle Hidden `
        -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$script:wrapper`"") `
        -RedirectStandardOutput $script:outFile -RedirectStandardError $script:errFile)
}

$DetectedIP = try {
    (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
} catch { '' }
if (-not $DetectedIP) { $DetectedIP = '127.0.0.1' }

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="NocVault Suite Test" Height="620" Width="780"
        WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize"
        Background="#F4F6F9" FontFamily="Segoe UI">
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="72"/><RowDefinition Height="*"/><RowDefinition Height="64"/>
    </Grid.RowDefinitions>

    <Border Grid.Row="0" Background="#1A2744">
      <StackPanel VerticalAlignment="Center" Margin="20,0">
        <TextBlock Text="NocVault Suite" Foreground="White" FontSize="20" FontWeight="SemiBold"/>
        <TextBlock Text="Post-Install Smoke Test" Foreground="#9FB0C9" FontSize="12"/>
      </StackPanel>
    </Border>

    <Grid Grid.Row="1" Margin="20,16,20,8">
      <StackPanel x:Name="ConfigPanel">
        <TextBlock Text="Server IP address" FontWeight="SemiBold" Margin="0,0,0,4"/>
        <TextBox x:Name="TxtServerIP" Height="28" Padding="6,4" Margin="0,0,0,12"/>

        <TextBlock Text="Install location" FontWeight="SemiBold" Margin="0,0,0,4"/>
        <TextBox x:Name="TxtInstallDir" Text="C:\Apps" Height="28" Padding="6,4" Margin="0,0,0,14"/>

        <CheckBox x:Name="ChkSkipDb" Content="Skip database + collector-DB checks (no password needed)" Margin="0,0,0,8"/>
        <CheckBox x:Name="ChkLogin" Content="Attempt a real login with default admin credentials" Margin="0,0,0,14"/>

        <StackPanel x:Name="PwPanel">
          <TextBlock Text="PostgreSQL 'postgres' password (for the DB + collector checks)" FontSize="12" Margin="0,0,0,4"/>
          <PasswordBox x:Name="PwPg" Height="28" Padding="6,4" Width="360" HorizontalAlignment="Left"/>
        </StackPanel>
      </StackPanel>

      <StackPanel x:Name="ProgressPanel" Visibility="Collapsed">
        <TextBlock x:Name="LblStep" Text="Starting..." FontSize="15" FontWeight="SemiBold" Margin="0,0,0,8"/>
        <ProgressBar x:Name="Bar" Height="20" Minimum="0" Maximum="100" Value="0" Foreground="#2563EB"/>
        <StackPanel Orientation="Horizontal" Margin="0,8,0,10">
          <Border Background="#ECFDF3" CornerRadius="4" Padding="8,3" Margin="0,0,8,0">
            <TextBlock x:Name="LblPass" Text="PASS 0" Foreground="#15803D" FontWeight="SemiBold" FontSize="12"/></Border>
          <Border Background="#FFFBEB" CornerRadius="4" Padding="8,3" Margin="0,0,8,0">
            <TextBlock x:Name="LblWarn" Text="WARN 0" Foreground="#B45309" FontWeight="SemiBold" FontSize="12"/></Border>
          <Border Background="#FEF2F2" CornerRadius="4" Padding="8,3">
            <TextBlock x:Name="LblFail" Text="FAIL 0" Foreground="#B91C1C" FontWeight="SemiBold" FontSize="12"/></Border>
        </StackPanel>
        <Border Background="#0D1220" CornerRadius="6" Padding="2">
          <TextBox x:Name="TxtLog" Height="300" Background="#0D1220" Foreground="#CBD5E1"
                   FontFamily="Consolas" FontSize="12" BorderThickness="0"
                   IsReadOnly="True" VerticalScrollBarVisibility="Auto" TextWrapping="NoWrap"/>
        </Border>
      </StackPanel>
    </Grid>

    <Border Grid.Row="2" Background="#FFFFFF" BorderBrush="#E2E8F0" BorderThickness="0,1,0,0">
      <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center" Margin="0,0,20,0">
        <TextBlock x:Name="LblStatus" Text="" VerticalAlignment="Center" Foreground="#64748B" Margin="0,0,16,0"/>
        <Button x:Name="BtnCancel" Content="Cancel" Width="90" Height="32" Margin="0,0,10,0"/>
        <Button x:Name="BtnRun" Content="Run Test" Width="120" Height="32"
                Background="#2563EB" Foreground="White" BorderThickness="0" FontWeight="SemiBold"/>
      </StackPanel>
    </Border>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$win    = [Windows.Markup.XamlReader]::Load($reader)
$win.TaskbarItemInfo = New-Object System.Windows.Shell.TaskbarItemInfo
$el = @{}
'ConfigPanel','TxtServerIP','TxtInstallDir','ChkSkipDb','ChkLogin','PwPanel','PwPg',
'ProgressPanel','LblStep','Bar','LblPass','LblWarn','LblFail','TxtLog','LblStatus','BtnCancel','BtnRun' | ForEach-Object {
    $el[$_] = $win.FindName($_)
}
$el.TxtServerIP.Text = $DetectedIP
$el.Bar.Add_ValueChanged({ try { $win.TaskbarItemInfo.ProgressValue = ([double]$el.Bar.Value / 100) } catch {} })
$togglePw = { $el.PwPanel.IsEnabled = -not $el.ChkSkipDb.IsChecked }
$el.ChkSkipDb.Add_Checked($togglePw); $el.ChkSkipDb.Add_Unchecked($togglePw)

$script:proc=$null; $script:timer=$null; $script:outFile=$null; $script:errFile=$null; $script:wrapper=$null
$script:logFile=$null; $script:logName='NocVault-Suite-Test'
$script:seen=0; $script:step=0; $script:total=12
$script:pass=0; $script:warn=0; $script:fail=0; $script:prevBar=$false

function Append-Log($t) {
    $el.TxtLog.AppendText($t + "`r`n"); $el.TxtLog.ScrollToEnd()
    if ($script:logFile) { try { Add-Content -LiteralPath $script:logFile -Value $t -Encoding UTF8 } catch {} }
}

$el.BtnRun.Add_Click({
    if (-not (Test-Path $TestPs1)) {
        [System.Windows.MessageBox]::Show("Test-NocVault-Suite.ps1 was not found next to this tester:`n$TestPs1",
            'NocVault Suite Test','OK','Error') | Out-Null
        return
    }
    $serverIP  = $el.TxtServerIP.Text.Trim()
    $installDir= $el.TxtInstallDir.Text.Trim()
    $skipDb    = [bool]$el.ChkSkipDb.IsChecked
    $pgPass    = $el.PwPg.Password
    if (-not $skipDb -and [string]::IsNullOrWhiteSpace($pgPass)) {
        [System.Windows.MessageBox]::Show("Enter the PostgreSQL 'postgres' password, or tick 'Skip database checks'.",
            'NocVault Suite Test','OK','Warning') | Out-Null
        return
    }

    $cmd = "& $(Q $TestPs1) -ServerIP $(Q $serverIP) -InstallDir $(Q $installDir)"
    if ($skipDb) { $cmd += ' -SkipDb' } else { $cmd += " -PgPassword $(Q $pgPass)" }
    if ($el.ChkLogin.IsChecked) { $cmd += ' -TestLogin' }

    $el.ConfigPanel.Visibility='Collapsed'; $el.ProgressPanel.Visibility='Visible'
    $el.BtnRun.IsEnabled=$false; $el.LblStatus.Text='Running...'
    try { $win.TaskbarItemInfo.ProgressState = 'Normal' } catch {}
    $script:seen=0; $script:step=0; $script:pass=0; $script:warn=0; $script:fail=0; $script:prevBar=$false

    try {
        $script:proc = Start-EngineWorker $cmd
    } catch {
        $el.LblStep.Text='Failed to start'; $el.LblStatus.Text="Could not start tester: $($_.Exception.Message)"
        $el.LblStatus.Foreground='#B91C1C'; $el.BtnCancel.Content='Close'; return
    }

    $script:timer = New-Object System.Windows.Threading.DispatcherTimer
    $script:timer.Interval = [TimeSpan]::FromMilliseconds(300)
    $script:timer.Add_Tick({
        $lines=@(); try { $lines = Get-Content -LiteralPath $script:outFile -ErrorAction SilentlyContinue } catch {}
        if ($lines.Count -gt $script:seen) {
            for ($i=$script:seen; $i -lt $lines.Count; $i++) {
                $ln = $lines[$i]
                if ($ln -match '^={10,}\s*$') { $script:prevBar=$true }
                elseif ($script:prevBar -and $ln -match '^\s+(?!\[)\S') {
                    # a Section title line ('  <Title>' between two ==== bars)
                    $script:step++
                    $el.LblStep.Text = $ln.Trim()
                    $pct=[math]::Min(95,[int](($script:step/[math]::Max(1,$script:total))*100))
                    $el.Bar.Value=$pct
                    $script:prevBar=$false
                } else { $script:prevBar=$false }

                if     ($ln -match '\[ PASS \]') { $script:pass++; $el.LblPass.Text="PASS $($script:pass)" }
                elseif ($ln -match '\[ FAIL \]') { $script:fail++; $el.LblFail.Text="FAIL $($script:fail)" }
                elseif ($ln -match '\[ WARN \]') { $script:warn++; $el.LblWarn.Text="WARN $($script:warn)" }
                Append-Log $ln
            }
            $script:seen = $lines.Count
        }
        if ($script:proc.HasExited) {
            try { $e = Get-Content -LiteralPath $script:errFile -ErrorAction SilentlyContinue; if ($e){ foreach ($x in $e){ Append-Log "[stderr] $x" } } } catch {}
            Remove-Item $script:outFile,$script:errFile,$script:wrapper -ErrorAction SilentlyContinue
            $script:timer.Stop()
            $el.Bar.Value=100
            $ok = ($script:fail -eq 0)
            try { $win.TaskbarItemInfo.ProgressState = if ($ok) { 'Normal' } else { 'Error' } } catch {}
            $el.LblStep.Text = if ($ok) { 'All checks passed' } else { "$($script:fail) check(s) failed" }
            $el.Bar.Foreground = if ($ok) { '#15803D' } else { '#B91C1C' }
            $el.LblStatus.Text = "PASS $($script:pass)  WARN $($script:warn)  FAIL $($script:fail)"
            $el.LblStatus.Foreground = if ($ok) { '#15803D' } else { '#B91C1C' }
            $el.BtnRun.IsEnabled=$false; $el.BtnCancel.Content='Close'
            if ($script:logFile) {
                $el.TxtLog.AppendText("`r`nFull log saved to: $($script:logFile)`r`n"); $el.TxtLog.ScrollToEnd()
                if (-not $ok) { try { Start-Process notepad.exe $script:logFile } catch {} }
            }
        }
    })
    $script:timer.Start()
})

$el.BtnCancel.Add_Click({
    if ($script:proc -and -not $script:proc.HasExited) {
        try { $script:proc.Kill() } catch {}; if ($script:timer){ $script:timer.Stop() }
    }
    $win.Close()
})

$win.ShowDialog() | Out-Null
