'use strict';
/**
 * modules/ddi/ipam.js — ICMP ping sweep of a subnet, ported from DDIVault's
 * collector/ipamScanner.js (+ scanWorker.js). The COLLECTION only: given a CIDR, sweep
 * every host with PS5 Test-Connection background jobs and return raw
 * `[{ ip, alive, ping_ms }]` rows — the field names DDIVault's writeScanResult consumes
 * (Phase 4b). Everything else the scanner did — DHCP-lease correlation, ARP MAC lookup,
 * device classification, alerting, and the DB writes — stays on the DDIVault server; the
 * writer defaults the enrichment fields (mac_address/hostname/is_dhcp) it doesn't receive,
 * so the agent ships raw reachability and the server enriches + stores.
 *
 * PS5-compatible: no -TimeoutSeconds / -Parallel (PS7 only); uses Start-Job + -Quiet, run
 * from a temp .ps1 via -ExecutionPolicy Bypass -File (avoids -Command newline truncation),
 * exactly as the source.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCAN_PS_TIMEOUT = parseInt(process.env.SCAN_PS_TIMEOUT_MS || '40000', 10);

// Generate all host IPs in a subnet (verbatim range/safety logic from ipamScanner.js:
// /16../30 only, max ~1022 hosts / /22, network + broadcast excluded).
function generateHostIPs(network, prefix) {
  if (prefix < 16 || prefix > 30) return [];
  const parts = network.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) return [];
  const hostCount = Math.pow(2, 32 - prefix) - 2;
  if (hostCount > 1022) return [];
  let base = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  base = (base & (~0 << (32 - prefix))) >>> 0;
  const ips = [];
  for (let i = 1; i <= hostCount; i++) {
    const ip = (base + i) >>> 0;
    ips.push(`${(ip >>> 24) & 255}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`);
  }
  return ips;
}

// Write a PS script to a temp file and run it (async, non-blocking). Returns stdout or null.
function runPsScript(scriptContent, timeoutMs, tag) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `nvagent_ddi_scan_${process.pid}_${tag}.ps1`);
    try {
      fs.writeFileSync(tmpFile, scriptContent, 'utf8');
    } catch (_e) {
      return resolve(null);
    }
    execFile(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { encoding: 'utf8', timeout: timeoutMs || SCAN_PS_TIMEOUT, maxBuffer: 1024 * 1024 * 8, windowsHide: true },
      (err, stdout) => {
        try { fs.unlinkSync(tmpFile); } catch (_e) { /* best-effort */ }
        resolve(err && !stdout ? null : (stdout || '').trim());
      }
    );
  });
}

/**
 * Ping sweep of a list of IPs using PS5 background jobs (batched + concurrent, as the
 * source). Returns an array of { ip, alive, ping_ms } — `ping_ms` matches the field
 * DDIVault's writeScanResult reads. Never throws.
 */
async function pingSweep(ips) {
  const results = [];
  if (!ips.length) return results;
  const BATCH = 50;
  const CONCURRENT_BATCHES = 3;
  const batches = [];
  for (let i = 0; i < ips.length; i += BATCH) batches.push(ips.slice(i, i + BATCH));

  const runBatch = async (batch, idx) => {
    const ipArray = batch.map((ip) => `'${ip}'`).join(',');
    const script = `
$ips = @(${ipArray})
$jobs = @()
foreach ($ip in $ips) {
    $jobs += Start-Job -ScriptBlock {
        param($target)
        $alive = Test-Connection -ComputerName $target -Count 1 -Quiet -ErrorAction SilentlyContinue
        if ($alive) {
            $p = Test-Connection -ComputerName $target -Count 1 -ErrorAction SilentlyContinue
            $ms = if ($p -and $p.ResponseTime) { $p.ResponseTime } else { 0 }
            Write-Output "$target,true,$ms"
        } else { Write-Output "$target,false," }
    } -ArgumentList $ip
}
$jobs | Wait-Job -Timeout 15 | Out-Null
foreach ($job in $jobs) {
    $out = Receive-Job $job -ErrorAction SilentlyContinue
    if ($out) { Write-Output $out }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
}
`;
    const raw = await runPsScript(script, SCAN_PS_TIMEOUT, `b${idx}`);
    const out = [];
    if (raw) {
      for (const line of raw.split('\n')) {
        const parts = line.trim().split(',');
        if (parts.length >= 2) {
          const ip = parts[0].trim();
          const alive = parts[1].trim() === 'true';
          const ms = parts[2] ? parseInt(parts[2].trim(), 10) : null;
          if (ip) out.push({ ip, alive, ping_ms: alive ? (ms || 0) : null });
        }
      }
    } else {
      // Batch failed — report the hosts as not-alive rather than dropping them.
      for (const ip of batch) out.push({ ip, alive: false, ping_ms: null });
    }
    return out;
  };

  for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
    const chunk = batches.slice(i, i + CONCURRENT_BATCHES);
    const chunkOut = await Promise.all(chunk.map((b, k) => runBatch(b, i + k)));
    for (const rows of chunkOut) for (const row of rows) results.push(row);
  }
  return results;
}

// Parse "10.0.0.0/24" → sweep → raw rows. Never throws — returns [] on a bad CIDR.
async function scanCidr(cidr) {
  const [network, prefixStr] = String(cidr || '').trim().split('/');
  const prefix = parseInt(prefixStr, 10);
  if (!network || isNaN(prefix)) return [];
  const ips = generateHostIPs(network, prefix);
  if (!ips.length) return [];
  return pingSweep(ips);
}

module.exports = { scanCidr, pingSweep, generateHostIPs };
