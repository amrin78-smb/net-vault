<#
================================================================
  NocVault Suite - Demo Data Seeder (WPF GUI)
  ---------------------------------------------------------------
  Populates realistic demo data across the installed suite DBs so the
  dashboards render. Pick a history window (7/14/30/90 days), a volume,
  and which apps; optionally clear existing demo data first.

  It reads the postgres password from C:\ProgramData\NocVault\secrets.env,
  resolves node + the installed 'pg' module, and runs the bundled per-app
  seed scripts (seeds\<app>-seed.js) against each DB. No console, no prompts.

  Test:  powershell -NoProfile -ExecutionPolicy Bypass -File .\NocVault-Demo-Seed-GUI.ps1
  Build: .\Build-Setup-Exe.ps1  (-> NocVault-Demo-Seed.exe)
================================================================
#>
[CmdletBinding()]
param()

# resolve our own folder whether running as a .ps1 or a compiled ps2exe .exe
$SelfPath = if ($PSCommandPath) { $PSCommandPath }
            elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path }
            else { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }
$ScriptDir = Split-Path -Parent $SelfPath
$Compiled  = [string]::IsNullOrEmpty($PSCommandPath)

# ---------- self-elevate (hidden) : secrets.env may be admin-restricted ----------
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    try {
        if ($Compiled) { Start-Process -FilePath $SelfPath -Verb RunAs }
        else {
            Start-Process -FilePath (Get-Process -Id $PID).Path `
                -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","`"$SelfPath`"" -Verb RunAs
        }
    } catch { }
    exit
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$SecretsFile = 'C:\ProgramData\NocVault\secrets.env'
$SeedsDir    = Join-Path $ScriptDir 'seeds'

function Get-EnvVal([string]$file, [string]$key) {
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)) {
        if ($line -match "^\s*$([regex]::Escape($key))\s*=\s*(.+?)\s*$") { return $Matches[1].Trim() }
    }
    return $null
}
function Q([string]$s) { "'" + ($s -replace "'","''") + "'" }

# node.exe + a node_modules that contains 'pg' (from any installed app)
$PoshExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path $PoshExe)) { $PoshExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
$NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { foreach ($c in @("$env:ProgramFiles\nodejs\node.exe","${env:ProgramFiles(x86)}\nodejs\node.exe")) { if (Test-Path $c) { $NodeExe = $c; break } } }

# per-app definitions
$AppDefs = @(
    @{ Name='NetVault';  Db='netvault';  Seed='netvault-seed.js';  Chk='ChkNet'  },
    @{ Name='LogVault';  Db='logvault';  Seed='logvault-seed.js';  Chk='ChkLog'  },
    @{ Name='DDIVault';  Db='ddivault';  Seed='ddivault-seed.js';  Chk='ChkDdi'  },
    @{ Name='SpanVault'; Db='spanvault'; Seed='spanvault-seed.js'; Chk='ChkSpan' }
)

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="NocVault Suite - Demo Data Seeder" Height="600" Width="760"
        WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize"
        Background="#F4F6F9" FontFamily="Segoe UI">
  <Grid>
    <Grid.RowDefinitions><RowDefinition Height="72"/><RowDefinition Height="*"/><RowDefinition Height="64"/></Grid.RowDefinitions>

    <Border Grid.Row="0" Background="#1A2744">
      <StackPanel VerticalAlignment="Center" Margin="20,0">
        <TextBlock Text="NocVault Suite" Foreground="White" FontSize="20" FontWeight="SemiBold"/>
        <TextBlock Text="Demo Data Seeder" Foreground="#9FB0C9" FontSize="12"/>
      </StackPanel>
    </Border>

    <Grid Grid.Row="1" Margin="20,16,20,8">
      <StackPanel x:Name="ConfigPanel">
        <Grid Margin="0,0,0,14">
          <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="16"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
          <StackPanel Grid.Column="0">
            <TextBlock Text="Data history" FontWeight="SemiBold" Margin="0,0,0,4"/>
            <ComboBox x:Name="CmbDays" Height="28" SelectedIndex="1">
              <ComboBoxItem Content="Last 7 days"/><ComboBoxItem Content="Last 14 days"/>
              <ComboBoxItem Content="Last 30 days"/><ComboBoxItem Content="Last 90 days"/>
            </ComboBox>
          </StackPanel>
          <StackPanel Grid.Column="2">
            <TextBlock Text="Volume" FontWeight="SemiBold" Margin="0,0,0,4"/>
            <ComboBox x:Name="CmbVol" Height="28" SelectedIndex="1">
              <ComboBoxItem Content="Light"/><ComboBoxItem Content="Normal"/><ComboBoxItem Content="Heavy"/>
            </ComboBox>
          </StackPanel>
        </Grid>

        <TextBlock Text="Install location" FontWeight="SemiBold" Margin="0,0,0,4"/>
        <TextBox x:Name="TxtInstallDir" Text="C:\Apps" Height="28" Padding="6,4" Margin="0,0,0,14"/>

        <TextBlock Text="Apps to seed" FontWeight="SemiBold" Margin="0,0,0,6"/>
        <StackPanel Orientation="Horizontal" Margin="0,0,0,6">
          <CheckBox x:Name="ChkNet"  Content="NetVault"  IsChecked="True" Margin="0,0,20,0"/>
          <CheckBox x:Name="ChkLog"  Content="LogVault"  IsChecked="True" Margin="0,0,20,0"/>
          <CheckBox x:Name="ChkDdi"  Content="DDIVault"  IsChecked="True" Margin="0,0,20,0"/>
          <CheckBox x:Name="ChkSpan" Content="SpanVault" IsChecked="True"/>
        </StackPanel>
        <CheckBox x:Name="ChkAll" Content="All" IsChecked="True" Margin="0,0,0,14"/>

        <CheckBox x:Name="ChkReset" Content="Clear existing demo data first (only demo rows; logins + settings untouched)" IsChecked="True"/>

        <Border Background="#EFF6FF" BorderBrush="#BFD7F5" BorderThickness="1" CornerRadius="6" Padding="10" Margin="0,16,0,0">
          <TextBlock TextWrapping="Wrap" Foreground="#1D4ED8" FontSize="12"
            Text="Seeds realistic demo data (org 'Cahaya Teknologi Sdn Bhd', sites KL-HQ / PEN / JB). Run this on a demo/test install - it writes into the app databases. It never touches users, logins, or settings."/>
        </Border>
      </StackPanel>

      <StackPanel x:Name="ProgressPanel" Visibility="Collapsed">
        <TextBlock x:Name="LblStep" Text="Preparing..." FontSize="15" FontWeight="SemiBold" Margin="0,0,0,8"/>
        <ProgressBar x:Name="Bar" Height="20" Minimum="0" Maximum="100" Value="0" Foreground="#C8102E"/>
        <TextBlock x:Name="LblPct" Text="0%" FontSize="12" Foreground="#64748B" Margin="0,4,0,10"/>
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
        <Button x:Name="BtnSeed" Content="Seed" Width="120" Height="32"
                Background="#C8102E" Foreground="White" BorderThickness="0" FontWeight="SemiBold"/>
      </StackPanel>
    </Border>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$win    = [Windows.Markup.XamlReader]::Load($reader)
$win.TaskbarItemInfo = New-Object System.Windows.Shell.TaskbarItemInfo
$el = @{}
'ConfigPanel','CmbDays','CmbVol','TxtInstallDir','ChkNet','ChkLog','ChkDdi','ChkSpan','ChkAll','ChkReset',
'ProgressPanel','LblStep','Bar','LblPct','TxtLog','LblStatus','BtnCancel','BtnSeed' | ForEach-Object { $el[$_] = $win.FindName($_) }
$el.Bar.Add_ValueChanged({ try { $win.TaskbarItemInfo.ProgressValue = ([double]$el.Bar.Value / 100) } catch {} })

# "All" convenience toggles
$script:suppress = $false
$setAll = { param($v) $script:suppress=$true; $el.ChkNet.IsChecked=$v; $el.ChkLog.IsChecked=$v; $el.ChkDdi.IsChecked=$v; $el.ChkSpan.IsChecked=$v; $script:suppress=$false }
$el.ChkAll.Add_Checked({   & $setAll $true })
$el.ChkAll.Add_Unchecked({ & $setAll $false })
$syncAll = { if (-not $script:suppress) { $script:suppress=$true; $el.ChkAll.IsChecked = ($el.ChkNet.IsChecked -and $el.ChkLog.IsChecked -and $el.ChkDdi.IsChecked -and $el.ChkSpan.IsChecked); $script:suppress=$false } }
foreach ($c in @($el.ChkNet,$el.ChkLog,$el.ChkDdi,$el.ChkSpan)) { $c.Add_Checked($syncAll); $c.Add_Unchecked($syncAll) }

$script:proc=$null; $script:timer=$null; $script:outFile=$null; $script:errFile=$null; $script:wrapper=$null; $script:statusFile=$null
$script:logFile=$null; $script:seen=0; $script:step=0; $script:total=1

function Append-Log($t) {
    $el.TxtLog.AppendText($t + "`r`n"); $el.TxtLog.ScrollToEnd()
    if ($script:logFile) { try { Add-Content -LiteralPath $script:logFile -Value $t -Encoding UTF8 } catch {} }
}
function Finish($ok,$msg) {
    if ($script:timer) { $script:timer.Stop() }
    $el.Bar.Value = 100; $el.LblPct.Text = '100%'
    $el.LblStep.Text = if ($ok) { 'Demo data seeded' } else { 'Seeding failed' }
    $el.LblStatus.Text = $msg; $el.LblStatus.Foreground = if ($ok) { '#15803D' } else { '#B91C1C' }
    $el.BtnSeed.IsEnabled = $false; $el.BtnCancel.Content = 'Close'; $el.BtnCancel.IsEnabled = $true
    try { $win.TaskbarItemInfo.ProgressState = if ($ok) { 'Normal' } else { 'Error' } } catch {}
    if ($script:logFile) {
        $el.TxtLog.AppendText("`r`nFull log saved to: $($script:logFile)`r`n"); $el.TxtLog.ScrollToEnd()
        if (-not $ok) { try { Start-Process notepad.exe $script:logFile } catch {} }
    }
}

$el.BtnSeed.Add_Click({
    $installDir = $el.TxtInstallDir.Text.Trim()
    $daysMap = @(7,14,30,90); $days = $daysMap[[int]$el.CmbDays.SelectedIndex]
    $volMap  = @('light','normal','heavy'); $volume = $volMap[[int]$el.CmbVol.SelectedIndex]
    $reset = if ($el.ChkReset.IsChecked) { '1' } else { '0' }

    $selected = @($AppDefs | Where-Object { [bool]$el[$_.Chk].IsChecked })
    if ($selected.Count -eq 0) { [System.Windows.MessageBox]::Show('Select at least one app to seed.','Demo Seeder','OK','Warning')|Out-Null; return }

    # preflight: secrets, node, pg
    $pgPass = Get-EnvVal $SecretsFile 'POSTGRES_PASSWORD'
    if (-not $pgPass) { [System.Windows.MessageBox]::Show("Could not read the postgres password from`n$SecretsFile`n`nRun this on a machine where the NocVault suite is installed.",'Demo Seeder','OK','Error')|Out-Null; return }
    if (-not $NodeExe) { [System.Windows.MessageBox]::Show('node.exe was not found. Install the suite (which installs Node.js) first.','Demo Seeder','OK','Error')|Out-Null; return }
    $nodePath = $null
    foreach ($a in @('NetVault','LogVault','DDIVault','SpanVault')) { $p = Join-Path $installDir "$a\app\node_modules"; if (Test-Path (Join-Path $p 'pg')) { $nodePath = $p; break } }
    if (-not $nodePath) { [System.Windows.MessageBox]::Show("Could not find the 'pg' module under $installDir\<App>\app\node_modules.`nIs the suite installed at this location?",'Demo Seeder','OK','Error')|Out-Null; return }
    foreach ($a in $selected) { if (-not (Test-Path (Join-Path $SeedsDir $a.Seed))) { [System.Windows.MessageBox]::Show("Missing seed script: $($a.Seed) (expected in $SeedsDir).",'Demo Seeder','OK','Error')|Out-Null; return } }

    # build the wrapper: loop node per app, write OK/FAIL to a status file
    $script:statusFile = [System.IO.Path]::GetTempFileName()
    $script:wrapper    = Join-Path $env:TEMP ('nvseed_' + [guid]::NewGuid().ToString('N') + '.ps1')
    $lines = @()
    $lines += "`$ErrorActionPreference='Continue'"
    $lines += "`$env:PGHOST='localhost'; `$env:PGPORT='5432'; `$env:PGUSER='postgres'"
    $lines += "`$env:PGPASSWORD=$(Q $pgPass)"
    $lines += "`$env:DAYS='$days'; `$env:VOLUME='$volume'; `$env:RESET='$reset'"
    $lines += "`$env:NODE_PATH=$(Q $nodePath)"
    $lines += "`$ok=`$true"
    $n = $selected.Count; $i = 0
    foreach ($a in $selected) {
        $i++
        $lines += "Write-Host '=== Seeding $($a.Name) ($i of $n) ==='"
        $lines += "`$env:PGDATABASE='$($a.Db)'"
        $lines += "& $(Q $NodeExe) $(Q (Join-Path $SeedsDir $a.Seed))"
        $lines += "if (`$LASTEXITCODE -ne 0) { `$ok=`$false; Write-Host ('FATAL: $($a.Name) seed exited ' + `$LASTEXITCODE) }"
    }
    $lines += "Set-Content -LiteralPath $(Q $script:statusFile) -Value (`$(if (`$ok) {'OK'} else {'FAIL'})) -Encoding ASCII"
    Set-Content -LiteralPath $script:wrapper -Value ($lines -join "`r`n") -Encoding UTF8

    # log file on the Desktop
    $logDir = [Environment]::GetFolderPath('Desktop'); if (-not $logDir -or -not (Test-Path $logDir)) { $logDir = $env:TEMP }
    $script:logFile = Join-Path $logDir 'NocVault-Demo-Seed.log'
    try { Set-Content -LiteralPath $script:logFile -Value ("NocVault Demo Seeder`r`nHistory=$days days  Volume=$volume  Reset=$reset  Apps=$(( $selected | ForEach-Object { $_.Name }) -join ', ')`r`n" + ('=' * 60)) -Encoding UTF8 } catch { $script:logFile=$null }

    $el.ConfigPanel.Visibility='Collapsed'; $el.ProgressPanel.Visibility='Visible'
    $el.BtnSeed.IsEnabled=$false; $el.LblStatus.Text='Seeding...'
    try { $win.TaskbarItemInfo.ProgressState='Normal' } catch {}
    $script:seen=0; $script:step=0; $script:total=$n
    $script:outFile=[System.IO.Path]::GetTempFileName(); $script:errFile=[System.IO.Path]::GetTempFileName()

    try {
        $script:proc = Start-Process -FilePath $PoshExe -PassThru -WindowStyle Hidden `
            -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$script:wrapper`"") `
            -RedirectStandardOutput $script:outFile -RedirectStandardError $script:errFile
    } catch { Finish $false "Could not start seeder: $($_.Exception.Message)"; return }

    $script:timer = New-Object System.Windows.Threading.DispatcherTimer
    $script:timer.Interval = [TimeSpan]::FromMilliseconds(350)
    $script:timer.Add_Tick({
        $out=@(); try { $out = Get-Content -LiteralPath $script:outFile -ErrorAction SilentlyContinue } catch {}
        if ($out.Count -gt $script:seen) {
            for ($j=$script:seen; $j -lt $out.Count; $j++) {
                $ln = $out[$j]
                if ($ln -match '^===\s*Seeding\s+(.+?)\s+\((\d+) of (\d+)\)') {
                    $script:step=[int]$Matches[2]; $tot=[int]$Matches[3]
                    $el.LblStep.Text = "Seeding $($Matches[1])  ($($Matches[2]) of $($Matches[3]))"
                    $pct=[math]::Min(95,[int]((($script:step-1)/[math]::Max(1,$tot))*100)); $el.Bar.Value=$pct; $el.LblPct.Text="$pct%"
                }
                Append-Log $ln
            }
            $script:seen=$out.Count
        }
        if ($script:proc.HasExited) {
            try { $e=@(Get-Content -LiteralPath $script:errFile -ErrorAction SilentlyContinue); if ($e.Count){ if($script:logFile){foreach($x in $e){try{Add-Content -LiteralPath $script:logFile -Value "[stderr] $x" -Encoding UTF8}catch{}}}; Append-Log "  ($($e.Count) diagnostic/stderr lines hidden - see the saved log)" } } catch {}
            $status=''; try { $status = ("" + (Get-Content -LiteralPath $script:statusFile -Raw -ErrorAction SilentlyContinue)).Trim() } catch {}
            Remove-Item $script:outFile,$script:errFile,$script:wrapper,$script:statusFile -ErrorAction SilentlyContinue
            if ($status -eq 'OK') { Finish $true "Seeded $($script:total) app(s). Open the apps to see the demo data." }
            else { Finish $false 'One or more seeds failed - see the FATAL line / saved log.' }
        }
    })
    $script:timer.Start()
})

$el.BtnCancel.Add_Click({
    if ($script:proc -and -not $script:proc.HasExited) { try { $script:proc.Kill() } catch {}; if ($script:timer){ $script:timer.Stop() } }
    $win.Close()
})

$win.ShowDialog() | Out-Null
