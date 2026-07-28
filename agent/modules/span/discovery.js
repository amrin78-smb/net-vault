'use strict';
/**
 * modules/span/discovery.js — zero-touch ICMP+SNMP sweep.
 *
 * Extracted verbatim from the legacy SpanVault agent (agent.js:742-876),
 * preserving byte-for-byte on-wire behaviour. On a server "discover" command the
 * agent sweeps `msg.subnets` with ICMP (concurrency 32), SNMP-probes responders
 * for sysName/sysDescr (concurrency 16) with `msg.communities`, and ships EXACTLY:
 *   { type:'discovery', hosts:[ { ip_address, snmp_ok, sys_name, sys_descr,
 *                                 snmp_community, snmp_version } ] }
 * Constants preserved: MAX_SWEEP_HOSTS 4096, per-target expansion (CIDR /20..32,
 * 3-octet base, single IP), probe timeouts, and the single-flight `discovering`
 * guard.
 *
 * createDiscovery({ send, logger }) returns { run(msg) } — the `discovering`
 * flag lives per-instance here, matching the legacy module-level guard so a
 * second overlapping discover is ignored with the same log line.
 */
const os = require('os');
const ping = require('ping');
const snmp = require('net-snmp');
const { pingHost } = require('./ping');

const MAX_SWEEP_HOSTS = 4096;

function localSubnets() {
  const seen = new Set();
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const parts = String(a.address).split('.');
      if (parts.length !== 4) continue;
      const base = `${parts[0]}.${parts[1]}.${parts[2]}`; // bound the sweep to the /24
      if (!seen.has(base)) { seen.add(base); out.push({ base, self: a.address }); }
    }
  }
  return out;
}

function snmpProbe(ip, communities) {
  const tries = (communities && communities.length) ? communities : ['public'];
  return tryCommunity(ip, tries, 0);
}
function tryCommunity(ip, tries, i) {
  if (i >= tries.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let session;
    try {
      session = snmp.createSession(ip, tries[i], { timeout: 1500, retries: 0, version: snmp.Version2c });
    } catch (_e) { return resolve(null); }
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { session.close(); } catch (_e) {} resolve(v); };
    const timer = setTimeout(() => finish(null), 2500);
    // sysName (1.3.6.1.2.1.1.5.0), sysDescr (1.3.6.1.2.1.1.1.0)
    session.get(['1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.1.0'], (err, vbs) => {
      clearTimeout(timer);
      if (err || !vbs) return finish(null);
      const val = (k) => (vbs[k] && !snmp.isVarbindError(vbs[k])) ? String(vbs[k].value) : '';
      const sysName = val(0), sysDescr = val(1);
      if (!sysName && !sysDescr) return finish(null);
      finish({ sys_name: sysName, sys_descr: sysDescr, community: tries[i] });
    });
  }).then((v) => v || tryCommunity(ip, tries, i + 1));
}

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (next < items.length) { const idx = next++; ret[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return ret;
}

// Expand operator-supplied scan targets into a flat host list. Accepts CIDR
// ("10.0.0.0/24"), a 3-octet base ("10.0.0" → .1-.254), or a single IP. Total
// hosts are capped so a typo (e.g. /8) can't launch a massive sweep.
function ipToInt(ip) {
  const p = String(ip).split('.').map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function expandTarget(t) {
  t = String(t || '').trim();
  if (!t) return [];
  const cidr = t.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (cidr) {
    const prefix = parseInt(cidr[2], 10);
    const ipInt = ipToInt(cidr[1]);
    if (ipInt == null || prefix < 20 || prefix > 32) return []; // bound: /20 max (~4094)
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const net = (ipInt & mask) >>> 0;
    const size = Math.pow(2, 32 - prefix);
    const out = [];
    const start = prefix <= 30 ? 1 : 0;       // skip network address
    const end = prefix <= 30 ? size - 2 : size - 1; // skip broadcast
    for (let i = start; i <= end; i++) out.push(intToIp((net + i) >>> 0));
    return out;
  }
  if (/^\d+\.\d+\.\d+$/.test(t)) { const out = []; for (let h = 1; h <= 254; h++) out.push(`${t}.${h}`); return out; }
  if (ipToInt(t) != null) return [t];
  return [];
}
function buildTargets(msg) {
  // Operator-supplied subnets take precedence; otherwise sweep the agent's /24s.
  const list = (msg && Array.isArray(msg.subnets)) ? msg.subnets : [];
  if (list.length) {
    const seen = new Set();
    for (const t of list) for (const ip of expandTarget(t)) { if (!seen.has(ip)) seen.add(ip); if (seen.size >= MAX_SWEEP_HOSTS) break; }
    return Array.from(seen);
  }
  const ips = [];
  for (const sn of localSubnets()) for (let h = 1; h <= 254; h++) ips.push(`${sn.base}.${h}`);
  return ips;
}

function createDiscovery({ send, logger }) {
  let discovering = false;

  async function run(msg) {
    if (discovering) { logger.info('Discovery already running — ignoring'); return; }
    discovering = true;
    try {
      const communities = (msg && Array.isArray(msg.communities) && msg.communities.length) ? msg.communities : ['public'];
      const ips = buildTargets(msg);
      logger.info(`Discovery: sweeping ${ips.length} address(es)`);
      const alive = (await mapLimit(ips, 32, async (ip) => (await pingHost(ip)) ? ip : null)).filter(Boolean);
      const hosts = await mapLimit(alive, 16, async (ip) => {
        const info = await snmpProbe(ip, communities);
        return {
          ip_address: ip, snmp_ok: !!info,
          sys_name: info ? info.sys_name : '', sys_descr: info ? info.sys_descr : '',
          // Preserve the community/version that actually answered so adoption keeps
          // working credentials instead of falling back to 'public'/'2c'.
          snmp_community: info ? info.community : null,
          snmp_version: info ? '2c' : null,
        };
      });
      logger.info(`Discovery: ${hosts.length} live host(s) found`);
      send({ type: 'discovery', hosts });
    } finally {
      discovering = false;
    }
  }

  return { run };
}

module.exports = createDiscovery;
