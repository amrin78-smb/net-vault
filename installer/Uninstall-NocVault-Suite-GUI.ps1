<#
================================================================
  NocVault Suite - Graphical Uninstaller (WPF wrapper)
  ---------------------------------------------------------------
  A Windows-style window that DRIVES Uninstall-NocVault-Suite.ps1
  in the background with -Force, so there is no console and no
  typed 'REMOVE' prompt. Options map to the .ps1 switches.

  Test:   powershell -NoProfile -ExecutionPolicy Bypass -File .\Uninstall-NocVault-Suite-GUI.ps1
  Build:  .\Build-Setup-Exe.ps1   (-> NocVault-Suite-Uninstall.exe)
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

$UninstallPs1  = Join-Path $ScriptDir 'Uninstall-NocVault-Suite.ps1'

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="NocVault Suite Uninstaller" Height="560" Width="760"
        WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize"
        Background="#F4F6F9" FontFamily="Segoe UI">
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="72"/><RowDefinition Height="*"/><RowDefinition Height="64"/>
    </Grid.RowDefinitions>

    <Border Grid.Row="0" Background="#1A2744">
      <StackPanel VerticalAlignment="Center" Margin="20,0">
        <TextBlock Text="NocVault Suite" Foreground="White" FontSize="20" FontWeight="SemiBold"/>
        <TextBlock Text="Uninstaller" Foreground="#9FB0C9" FontSize="12"/>
      </StackPanel>
    </Border>

    <Grid Grid.Row="1" Margin="20,16,20,8">
      <StackPanel x:Name="ConfigPanel">
        <Border Background="#FDECEC" BorderBrush="#E9A5A5" BorderThickness="1" CornerRadius="6" Padding="10" Margin="0,0,0,14">
          <TextBlock TextWrapping="Wrap" Foreground="#B91C1C" FontSize="12"
            Text="This removes NetVault, LogVault, DDIVault and SpanVault: all NSSM services, scheduled tasks, firewall rules, the application folders, and (unless kept) the four databases and their data."/>
        </Border>

        <TextBlock Text="Install location" FontWeight="SemiBold" Margin="0,0,0,4"/>
        <TextBox x:Name="TxtInstallDir" Text="C:\Apps" Height="28" Padding="6,4" Margin="0,0,0,14"/>

        <CheckBox x:Name="ChkKeepDb" Content="Keep databases (preserve all data - skip the DROP step)" Margin="0,0,0,8"/>
        <CheckBox x:Name="ChkRemoveDeps" Content="Also uninstall shared prerequisites (Node.js, Git, PostgreSQL, VC++)" Margin="0,0,0,14"/>

        <StackPanel x:Name="PwPanel">
          <TextBlock Text="PostgreSQL 'postgres' password (needed to drop the databases)" FontSize="12" Margin="0,0,0,4"/>
          <PasswordBox x:Name="PwPg" Height="28" Padding="6,4" Width="360" HorizontalAlignment="Left"/>
        </StackPanel>

        <CheckBox x:Name="ChkConfirm" FontWeight="SemiBold" Foreground="#B91C1C" Margin="0,18,0,0"
                  Content="I understand this permanently removes NocVault and its data."/>
      </StackPanel>

      <StackPanel x:Name="ProgressPanel" Visibility="Collapsed">
        <TextBlock x:Name="LblStep" Text="Preparing..." FontSize="15" FontWeight="SemiBold" Margin="0,0,0,8"/>
        <ProgressBar x:Name="Bar" Height="22" Minimum="0" Maximum="100" Value="0" Foreground="#C8102E"/>
        <TextBlock x:Name="LblPct" Text="0%" FontSize="12" Foreground="#64748B" Margin="0,4,0,10"/>
        <Border Background="#0D1220" CornerRadius="6" Padding="2">
          <TextBox x:Name="TxtLog" Height="260" Background="#0D1220" Foreground="#CBD5E1"
                   FontFamily="Consolas" FontSize="12" BorderThickness="0"
                   IsReadOnly="True" VerticalScrollBarVisibility="Auto" TextWrapping="NoWrap"/>
        </Border>
      </StackPanel>
    </Grid>

    <Border Grid.Row="2" Background="#FFFFFF" BorderBrush="#E2E8F0" BorderThickness="0,1,0,0">
      <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center" Margin="0,0,20,0">
        <TextBlock x:Name="LblStatus" Text="" VerticalAlignment="Center" Foreground="#64748B" Margin="0,0,16,0"/>
        <Button x:Name="BtnCancel" Content="Cancel" Width="90" Height="32" Margin="0,0,10,0"/>
        <Button x:Name="BtnRemove" Content="Remove" Width="120" Height="32" IsEnabled="False"
                Background="#B91C1C" Foreground="White" BorderThickness="0" FontWeight="SemiBold"/>
      </StackPanel>
    </Border>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$win    = [Windows.Markup.XamlReader]::Load($reader)
$win.TaskbarItemInfo = New-Object System.Windows.Shell.TaskbarItemInfo
$el = @{}
'ConfigPanel','TxtInstallDir','ChkKeepDb','ChkRemoveDeps','PwPanel','PwPg','ChkConfirm',
'ProgressPanel','LblStep','Bar','LblPct','TxtLog','LblStatus','BtnCancel','BtnRemove' | ForEach-Object {
    $el[$_] = $win.FindName($_)
}

$el.Bar.Add_ValueChanged({ try { $win.TaskbarItemInfo.ProgressValue = ([double]$el.Bar.Value / 100) } catch {} })

# confirm checkbox gates the Remove button; keep-db disables the password field
$el.ChkConfirm.Add_Checked({   $el.BtnRemove.IsEnabled = $true })
$el.ChkConfirm.Add_Unchecked({ $el.BtnRemove.IsEnabled = $false })
$togglePw = { $el.PwPanel.IsEnabled = -not $el.ChkKeepDb.IsChecked }
$el.ChkKeepDb.Add_Checked($togglePw); $el.ChkKeepDb.Add_Unchecked($togglePw)

$script:proc=$null; $script:timer=$null; $script:outFile=$null; $script:errFile=$null
$script:seen=0; $script:step=0; $script:total=6

function Append-Log($t) { $el.TxtLog.AppendText($t + "`r`n"); $el.TxtLog.ScrollToEnd() }
function Finish($ok,$msg) {
    if ($script:timer) { $script:timer.Stop() }
    $el.Bar.Value = 100; $el.LblPct.Text = '100%'
    $el.LblStep.Text = if ($ok) { 'Uninstall complete' } else { 'Uninstall failed' }
    $el.LblStatus.Text = $msg
    $el.LblStatus.Foreground = if ($ok) { '#15803D' } else { '#B91C1C' }
    $el.BtnRemove.IsEnabled = $false
    $el.BtnCancel.Content = 'Close'; $el.BtnCancel.IsEnabled = $true
    try { $win.TaskbarItemInfo.ProgressState = if ($ok) { 'Normal' } else { 'Error' } } catch {}
}

$el.BtnRemove.Add_Click({
    if (-not (Test-Path $UninstallPs1)) {
        [System.Windows.MessageBox]::Show("Uninstall-NocVault-Suite.ps1 was not found next to this uninstaller:`n$UninstallPs1",
            'NocVault Suite Uninstaller','OK','Error') | Out-Null
        return
    }
    $installDir = $el.TxtInstallDir.Text.Trim()
    $keepDb     = [bool]$el.ChkKeepDb.IsChecked
    $removeDeps = [bool]$el.ChkRemoveDeps.IsChecked
    $pgPass     = $el.PwPg.Password
    if (-not $keepDb -and [string]::IsNullOrWhiteSpace($pgPass)) {
        [System.Windows.MessageBox]::Show("Enter the PostgreSQL 'postgres' password (needed to drop the databases), or tick 'Keep databases'.",
            'NocVault Suite Uninstaller','OK','Warning') | Out-Null
        return
    }

    $script:total = 7
    if ($keepDb)      { $script:total-- }   # no DROP databases step
    if (-not $removeDeps) { $script:total-- } # no remove-dependencies step

    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$UninstallPs1`"",
           '-Force','-InstallDir',"`"$installDir`"")
    if ($keepDb)     { $a += '-KeepDatabases' } else { $a += @('-PgAdminPassword',"`"$pgPass`"") }
    if ($removeDeps) { $a += '-RemoveDependencies' }

    $el.ConfigPanel.Visibility='Collapsed'; $el.ProgressPanel.Visibility='Visible'
    $el.BtnRemove.IsEnabled=$false; $el.LblStatus.Text='Removing...'
    try { $win.TaskbarItemInfo.ProgressState = 'Normal' } catch {}
    $script:outFile=[System.IO.Path]::GetTempFileName(); $script:errFile=[System.IO.Path]::GetTempFileName()
    $script:seen=0; $script:step=0

    try {
        $script:proc = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $a `
            -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:outFile -RedirectStandardError $script:errFile
    } catch { Finish $false "Could not start uninstaller: $($_.Exception.Message)"; return }

    $script:timer = New-Object System.Windows.Threading.DispatcherTimer
    $script:timer.Interval = [TimeSpan]::FromMilliseconds(350)
    $script:timer.Add_Tick({
        $lines=@(); try { $lines = Get-Content -LiteralPath $script:outFile -ErrorAction SilentlyContinue } catch {}
        if ($lines.Count -gt $script:seen) {
            for ($i=$script:seen; $i -lt $lines.Count; $i++) {
                $ln = $lines[$i]
                if ($ln -match '^\s*==>\s*(.+?)\s*$') {
                    $script:step++
                    $el.LblStep.Text = ("Step {0} of {1}: {2}" -f $script:step,$script:total,$Matches[1])
                    $pct=[math]::Min(95,[int](($script:step/[math]::Max(1,$script:total))*100))
                    $el.Bar.Value=$pct; $el.LblPct.Text="$pct%"
                }
                Append-Log $ln
            }
            $script:seen = $lines.Count
        }
        if ($script:proc.HasExited) {
            try { $e = Get-Content -LiteralPath $script:errFile -ErrorAction SilentlyContinue; if ($e) { foreach ($x in $e){ Append-Log "[stderr] $x" } } } catch {}
            Remove-Item $script:outFile,$script:errFile -ErrorAction SilentlyContinue
            if ($script:proc.ExitCode -eq 0) { Finish $true 'NocVault Suite removed.' }
            else { Finish $false "Uninstaller exited with code $($script:proc.ExitCode). See log above." }
        }
    })
    $script:timer.Start()
})

$el.BtnCancel.Add_Click({
    if ($script:proc -and -not $script:proc.HasExited) {
        $r=[System.Windows.MessageBox]::Show('Uninstall is running. Stop it now? The system may be left half-removed.',
            'NocVault Suite Uninstaller','YesNo','Warning')
        if ($r -ne 'Yes') { return }
        try { $script:proc.Kill() } catch {}; if ($script:timer){ $script:timer.Stop() }
    }
    $win.Close()
})

$win.ShowDialog() | Out-Null
