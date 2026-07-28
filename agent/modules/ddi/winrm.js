'use strict';
/**
 * modules/ddi/winrm.js — PowerShell/WinRM runner + the per-type DHCP/DNS readers,
 * ported from DDIVault's collector/powershellRunner.js to run INSIDE the Node agent.
 *
 * Two deliberate differences from the source (both required to be a good agent citizen,
 * not behaviour changes on the wire):
 *   1. ASYNC: the DDIVault collector shells out with the BLOCKING execSync (fine there —
 *      it is a dedicated background process). Inside the agent that would freeze the WS
 *      event loop (heartbeats, buffer flush) for the whole 30-60s WinRM call, so every
 *      call here uses child_process.execFile (non-blocking, returns a Promise).
 *   2. No cmd.exe: execFile invokes powershell.exe directly (no shell), so the whole PS
 *      command is passed as ONE `-Command` argument — the `\\`/`"` shell-escaping the
 *      source needed for the `-Command "..."` string form is not needed (and the PS
 *      scripts here only ever use single quotes internally). Scripts are still kept on a
 *      SINGLE line — a defensive habit carried over from the source.
 *
 * The COLLECTION (produce raw rows) lives here; the DB writes stay on the DDIVault server.
 * Only the READ path is ported (the collector's WRITE helpers — Add/Remove/Set — are not
 * an agent concern; DHCP/DNS mutations still run server-side).
 *
 * Per-server auth (matches the DDIVault `ddi_servers` shape):
 *   auth_mode:   'kerberos' | 'credential' | 'local'
 *   ps_username: domain\\user or user@domain
 *   ps_password: plaintext (decrypted by the server before it reached the ddi_config)
 *   winrm_port:  5985 (HTTP) or 5986 (HTTPS)
 *   winrm_https: boolean
 */
const { execFile } = require('child_process');

const PS_TIMEOUT = parseInt(process.env.PS_TIMEOUT_MS || '30000', 10);
// DNS zone collection on servers with many zones (100+) takes far longer than a standard
// DHCP query, so DNS reads use a dedicated, larger timeout (60s default) — as in the source.
const DNS_PS_TIMEOUT = parseInt(process.env.PS_DNS_TIMEOUT_MS || '60000', 10);
const MAX_BUFFER = 1024 * 1024 * 16;

// PostgreSQL inet values include CIDR (e.g. 172.24.0.10/32) which the PowerShell remoting
// functions reject — strip it before any PS use.
const cleanIp = (ip) => (ip || '').replace(/\/\d+$/, '').trim();

/**
 * Execute a PowerShell script against a server with the given per-server auth.
 * Returns a Promise resolving to the parsed JSON (returnRaw=false, default) or the raw
 * stdout string (returnRaw=true), or null on any failure. NEVER rejects — a WinRM error
 * for one server must not crash the agent; the caller decides what to do with null.
 */
function runPS(serverIp, script, auth, returnRaw, timeoutMs) {
  return new Promise((resolve) => {
    const ip = cleanIp(serverIp);
    if (!ip) return resolve(returnRaw ? '' : null);

    const mode = (auth && auth.auth_mode) || 'kerberos';
    const user = (auth && auth.ps_username) || '';
    const pass = (auth && auth.ps_password) || '';
    const port = (auth && auth.winrm_port) || 5985;
    const useHttps = (auth && auth.winrm_https) || false;

    const portOpt = port && port !== 5985 ? ` -Port ${port}` : '';
    const httpsOpt = useHttps ? ' -UseSSL' : '';

    let psCmd;
    if (mode === 'local') {
      // Run directly on this machine — only when the agent host IS the target server.
      psCmd = `try { ${script} } catch { Write-Error $_.Exception.Message; exit 1 }`;
    } else if (mode === 'credential') {
      if (!user || !pass) return resolve(returnRaw ? '' : null);
      const safePass = pass.replace(/'/g, "''");
      const safeUser = user.replace(/'/g, "''");
      psCmd =
        `$secPass = ConvertTo-SecureString '${safePass}' -AsPlainText -Force; ` +
        `$cred = New-Object System.Management.Automation.PSCredential('${safeUser}', $secPass); ` +
        `try { Invoke-Command -ComputerName '${ip}'${portOpt}${httpsOpt} -Credential $cred -ScriptBlock { ${script} } } ` +
        `catch { Write-Error $_.Exception.Message; exit 1 }`;
    } else {
      // kerberos — current Windows identity (the agent's service account).
      psCmd =
        `try { Invoke-Command -ComputerName '${ip}'${portOpt}${httpsOpt} -ScriptBlock { ${script} } } ` +
        `catch { Write-Error $_.Exception.Message; exit 1 }`;
    }

    execFile(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-Command', psCmd],
      { encoding: 'utf8', timeout: timeoutMs || PS_TIMEOUT, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout) => {
        const raw = (stdout || '').trim();
        if (err && !raw) return resolve(returnRaw ? '' : null);
        if (!raw) return resolve(returnRaw ? '' : null);
        if (returnRaw) return resolve(raw);
        try {
          return resolve(JSON.parse(raw));
        } catch (_e) {
          return resolve(null);
        }
      }
    );
  });
}

// ConvertTo-Json emits a bare object for a single row and an array for many — normalise.
const asArray = (r) => (r == null ? [] : Array.isArray(r) ? r : [r]);

/** Cheap WinRM reachability probe — { ok, error, latencyMs }. Never rejects. */
async function testWinRM(serverIp, auth) {
  const ip = cleanIp(serverIp);
  if (!ip) return { ok: false, error: 'No server IP', latencyMs: null };
  const start = Date.now();
  const r = await runPS(ip, `Write-Output 'winrm-ok'`, auth, true, 15000);
  const latencyMs = Date.now() - start;
  if (r && r.includes('winrm-ok')) return { ok: true, error: null, latencyMs };
  return { ok: false, error: 'Unreachable', latencyMs };
}

// ════════════════════════════════════════════════════════════
// DHCP — READ
// ════════════════════════════════════════════════════════════
async function getDhcpScopeStats(serverIp, auth) {
  return asArray(await runPS(serverIp,
    `Get-DhcpServerv4ScopeStatistics | Select-Object ScopeId,PercentageInUse,InUse,Free,Reserved,Pending | ConvertTo-Json -Depth 5 -Compress`,
    auth));
}

async function getDhcpScopes(serverIp, auth) {
  return asArray(await runPS(serverIp,
    `Get-DhcpServerv4Scope | Select-Object ScopeId,Name,StartRange,EndRange,SubnetMask,State,LeaseDuration,Description | ConvertTo-Json -Depth 5 -Compress`,
    auth));
}

async function getDhcpLeases(serverIp, auth) {
  // -AllScope is unsupported on PS5, so loop over each scope. SINGLE line.
  const script = `$all = foreach ($s in (Get-DhcpServerv4Scope | Select-Object -ExpandProperty ScopeId)) { Get-DhcpServerv4Lease -ScopeId $s -ErrorAction SilentlyContinue | Select-Object ScopeId,IPAddress,HostName,ClientId,AddressState,LeaseExpiryTime }; $all | ConvertTo-Json -Depth 5 -Compress`;
  return asArray(await runPS(serverIp, script, auth));
}

// scopeId optional — when null/omitted, returns reservations across ALL scopes.
async function getDhcpReservations(serverIp, scopeId, auth) {
  const script = scopeId
    ? `Get-DhcpServerv4Reservation -ScopeId '${scopeId}' | Select-Object ScopeId,IPAddress,ClientId,Name,Description,Type | ConvertTo-Json -Depth 5 -Compress`
    : `$scopes = Get-DhcpServerv4Scope | Select-Object -ExpandProperty ScopeId; $all = foreach ($s in $scopes) { Get-DhcpServerv4Reservation -ScopeId $s -ErrorAction SilentlyContinue | Select-Object ScopeId,IPAddress,ClientId,Name,Description,Type }; $all | ConvertTo-Json -Depth 5 -Compress`;
  return asArray(await runPS(serverIp, script, auth));
}

async function getDhcpScopeOptions(serverIp, auth, scopeId) {
  const script = `Get-DhcpServerv4OptionValue -ScopeId '${scopeId}' -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ OptionId = $_.OptionId; Name = $_.Name; Value = ($_.Value -join ', ') } } | ConvertTo-Json -Compress`;
  return asArray(await runPS(cleanIp(serverIp), script, auth));
}

// ════════════════════════════════════════════════════════════
// DNS — READ
// ════════════════════════════════════════════════════════════
async function getDnsZones(serverIp, auth) {
  return asArray(await runPS(serverIp,
    `Get-DnsServerZone | Select-Object ZoneName,ZoneType,IsAutoCreated,IsDsIntegrated,IsReverseLookupZone,IsReadOnly | ConvertTo-Json -Depth 5 -Compress`,
    auth, false, DNS_PS_TIMEOUT));
}

async function getDnsRecords(serverIp, zoneName, auth) {
  const z = String(zoneName).replace(/'/g, "''");
  const script = `Get-DnsServerResourceRecord -ZoneName '${z}' | ForEach-Object { $r = $_; $data = ''; try { if ($r.RecordData.IPv4Address) { $data = $r.RecordData.IPv4Address.IPAddressToString } elseif ($r.RecordData.IPv6Address) { $data = $r.RecordData.IPv6Address.IPAddressToString } elseif ($r.RecordData.HostNameAlias) { $data = $r.RecordData.HostNameAlias } elseif ($r.RecordData.MailExchange) { $data = $r.RecordData.MailExchange + ' ' + $r.RecordData.Preference } elseif ($r.RecordData.NameServer) { $data = $r.RecordData.NameServer } elseif ($r.RecordData.DescriptiveText) { $data = $r.RecordData.DescriptiveText } else { $data = '' } } catch {}; [PSCustomObject]@{ HostName=$r.HostName; RecordType=$r.RecordType; TTL=[int]$r.TimeToLive.TotalSeconds; RecordData=$data } } | ConvertTo-Json -Depth 5 -Compress`;
  return asArray(await runPS(serverIp, script, auth, false, DNS_PS_TIMEOUT));
}

// ── DNS health readers (feed the aggregated dns_health kind) ──────────────────
async function getDnsServerRole(serverIp, auth) {
  const script = `$d=(Get-WmiObject Win32_ComputerSystem).Domain;$pdc=(Get-ADDomain -ErrorAction SilentlyContinue).PDCEmulator;$isPdc=$pdc -eq "$env:COMPUTERNAME.$d";$fwd=(Get-DnsServerForwarder -ErrorAction SilentlyContinue).IPAddress.IPAddressToString -join ',';[PSCustomObject]@{isPDC=[bool]$isPdc;forwarders="$fwd";domain="$d"}|ConvertTo-Json -Compress`;
  return runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

async function getDnsZoneSoaDetail(serverIp, auth, zoneName) {
  const z = String(zoneName).replace(/'/g, "''");
  const script = `Get-DnsServerResourceRecord -ZoneName '${z}' -RRType Soa -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $soa = $_.RecordData; [PSCustomObject]@{ Serial=$soa.SerialNumber; PrimaryServer=$soa.PrimaryServer; AdminEmail=$soa.ResponsiblePerson; Refresh=$soa.RefreshInterval.TotalSeconds; Retry=$soa.RetryDelay.TotalSeconds; Expire=$soa.ExpireLimit.TotalSeconds; MinTTL=$soa.TimeToLive.TotalSeconds } } | ConvertTo-Json -Compress`;
  return runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

async function getDnsZoneRecordCounts(serverIp, auth, zoneName) {
  const z = String(zoneName).replace(/'/g, "''");
  const script = `$recs = Get-DnsServerResourceRecord -ZoneName '${z}' -ErrorAction SilentlyContinue; [PSCustomObject]@{ Total=$recs.Count; A=($recs | Where-Object RecordType -eq 'A').Count; PTR=($recs | Where-Object RecordType -eq 'PTR').Count; CNAME=($recs | Where-Object RecordType -eq 'CNAME').Count; MX=($recs | Where-Object RecordType -eq 'MX').Count; TXT=($recs | Where-Object RecordType -eq 'TXT').Count; SRV=($recs | Where-Object RecordType -eq 'SRV').Count; AAAA=($recs | Where-Object RecordType -eq 'AAAA').Count } | ConvertTo-Json -Compress`;
  return runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

async function getDnsForwarders(serverIp, auth) {
  const script = `Get-DnsServerForwarder -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress | ForEach-Object { $_.IPAddressToString } | ConvertTo-Json -Compress`;
  return asArray(await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT));
}

async function getDnsZoneScavenging(serverIp, auth, zoneName) {
  const z = String(zoneName).replace(/'/g, "''");
  const script = `Get-DnsServerZoneAging -ZoneName '${z}' -ErrorAction SilentlyContinue | Select-Object AgingEnabled,ScavengeServers,NoRefreshInterval,RefreshInterval | ConvertTo-Json -Compress`;
  return runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

async function getDnsStaleRecords(serverIp, auth, zoneName, staleDays) {
  const z = String(zoneName).replace(/'/g, "''");
  const cutoff = parseInt(staleDays, 10) || 90;
  const script = `$cutoff = (Get-Date).AddDays(-${cutoff}); Get-DnsServerResourceRecord -ZoneName '${z}' -ErrorAction SilentlyContinue | Where-Object { $_.TimeStamp -and $_.TimeStamp -lt $cutoff -and $_.RecordType -ne 'SOA' -and $_.RecordType -ne 'NS' } | Select-Object HostName,RecordType,TimeStamp | ConvertTo-Json -Compress`;
  return asArray(await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT));
}

async function testDnsForwarder(serverIp, auth, forwarderIp) {
  const f = String(forwarderIp).replace(/'/g, "''");
  const script = `$start=Get-Date;$out=$null;try{$r=Resolve-DnsName -Name 'google.com' -Server '${f}' -Type A -ErrorAction Stop;$ms=[int](((Get-Date)-$start).TotalMilliseconds);$out=[PSCustomObject]@{Reachable=$true;ResponseMs=$ms;Forwarder='${f}'}}catch{$ms=[int](((Get-Date)-$start).TotalMilliseconds);$out=[PSCustomObject]@{Reachable=$false;ResponseMs=$ms;Forwarder='${f}'}};$out|ConvertTo-Json -Compress`;
  return runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

async function getDnsQueryStats(serverIp, auth) {
  const script = `$counters = Get-Counter -Counter '\\DNS\\Total Query Received/sec','\\DNS\\Total Response Sent/sec','\\DNS\\Total Query Received','\\DNS\\Recursive Queries/sec' -ErrorAction SilentlyContinue; $vals = @{}; if ($counters) { $counters.CounterSamples | ForEach-Object { $vals[$_.Path.Split('\\')[-1]] = [math]::Round($_.CookedValue,2) } }; $vals | ConvertTo-Json -Compress`;
  return runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// ════════════════════════════════════════════════════════════
// HA / FAILOVER / HEALTH — READ
// ════════════════════════════════════════════════════════════
async function getDhcpFailover(serverIp, auth) {
  return asArray(await runPS(serverIp,
    `Get-DhcpServerv4Failover -ErrorAction SilentlyContinue | Select-Object Name,PrimaryServerName,SecondaryServerName,State,Mode,LoadBalancePercent,MaxClientLeadTime,ScopeId | ConvertTo-Json -Depth 5 -Compress`,
    auth));
}

/** SOA serial for a zone (replication-lag detection). */
async function getDnsZoneSoa(serverIp, zoneName, auth) {
  const z = String(zoneName).replace(/'/g, "''");
  const script = `$rec = Get-DnsServerResourceRecord -ZoneName '${z}' -RRType SOA -ErrorAction SilentlyContinue | Select-Object -First 1; if ($rec) { [PSCustomObject]@{ ZoneName='${z}'; Serial=[int64]$rec.RecordData.SerialNumber } | ConvertTo-Json -Compress }`;
  return runPS(serverIp, script, auth);
}

module.exports = {
  runPS,
  cleanIp,
  asArray,
  testWinRM,
  // DHCP read
  getDhcpScopeStats,
  getDhcpScopes,
  getDhcpLeases,
  getDhcpReservations,
  getDhcpScopeOptions,
  // DNS read
  getDnsZones,
  getDnsRecords,
  // DNS health readers
  getDnsServerRole,
  getDnsZoneSoaDetail,
  getDnsZoneRecordCounts,
  getDnsForwarders,
  getDnsZoneScavenging,
  getDnsStaleRecords,
  testDnsForwarder,
  getDnsQueryStats,
  // HA / failover
  getDhcpFailover,
  getDnsZoneSoa,
};
