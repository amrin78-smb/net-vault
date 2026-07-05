#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * LogVault DEMO DATA seed script  (NocVault suite installer copy)
 * ============================================================================
 * Generates a realistic multi-day time-series of syslog events for the shared
 * NocVault demo scenario (Cahaya Teknologi Sdn Bhd) so the LogVault dashboard,
 * Log Explorer, Security tab and UEBA widgets look populated.
 *
 * SAFE TO RUN ONLY ON A TEST/DEMO DATABASE. It writes thousands of rows into
 * syslog_entries plus registry/security tables. Every demo syslog row carries
 * structured_data.demo = "true" so RESET can remove exactly what it created.
 *
 * This file follows the SHARED NocVault SEED CONTRACT used by all 4 app seeds:
 *   - `pg` is resolved at runtime (NODE_PATH set by the suite launcher) — no
 *     hardcoded module path.
 *   - Connection + behaviour come from the environment:
 *       PGHOST     (default localhost)
 *       PGPORT     (default 5432)
 *       PGUSER     (default postgres)          <- needs DELETE on syslog_entries
 *       PGPASSWORD (REQUIRED — no hardcoded default)
 *       PGDATABASE (default logvault)
 *       DAYS       (default 14)   history window in days
 *       VOLUME     (default normal)  light=2000 / normal=5000 / heavy=12000 rows
 *       TOTAL      (optional)     explicit syslog row count — wins over VOLUME
 *       RESET      (default 1)    delete demo rows first, then reseed
 *
 * NOTE: connect as a SUPERUSER / table owner (postgres). The app role
 * logvault_user has UPDATE/DELETE revoked on syslog_entries, so RESET and the
 * append-only inserts must run as postgres.
 * ============================================================================
 */

const { Client } = require('pg');

// ── tunables ────────────────────────────────────────────────────────────────
const DAYS = parseInt(process.env.DAYS || '14', 10);           // history window

// VOLUME drives the syslog row count unless TOTAL is explicitly provided.
const VOLUME = (process.env.VOLUME || 'normal').toLowerCase();
const VOLUME_ROWS = { light: 2000, normal: 5000, heavy: 12000 };
const TOTAL = process.env.TOTAL
  ? parseInt(process.env.TOTAL, 10)
  : (VOLUME_ROWS[VOLUME] || VOLUME_ROWS.normal);                // syslog rows

// RESET defaults ON (contract default = 1).
const RESET = process.env.RESET === undefined
  ? true
  : (process.env.RESET === '1' || process.env.RESET === 'true');

const BATCH_ROWS = 400;  // 400 * 18 cols = 7200 params (< 65535 limit)

if (!process.env.PGPASSWORD) {
  console.error('[logvault-seed] FATAL: PGPASSWORD is required (no hardcoded default).');
  process.exit(1);
}

const conn = {
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432', 10),
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'logvault',
  ssl:      false,
};

// ── tiny PRNG helpers ───────────────────────────────────────────────────────
const ri    = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick  = (arr)  => arr[Math.floor(Math.random() * arr.length)];
const chance = (p)   => Math.random() < p;
const pad2  = (n)    => String(n).padStart(2, '0');

function weightedPick(pairs) {
  // pairs: [ [weight, value], ... ]
  let total = 0;
  for (const [w] of pairs) total += w;
  let r = Math.random() * total;
  for (const [w, v] of pairs) { if ((r -= w) < 0) return v; }
  return pairs[pairs.length - 1][1];
}

// ── severity / facility helpers ─────────────────────────────────────────────
const SEV_LABEL = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
const sevLabel  = (s) => SEV_LABEL[s] || 'info';

// internal client IP within a site subnet (10.X.0.0/16)
const internalIp = (second) => `10.${second}.${ri(1, 6)}.${ri(2, 250)}`;

// External IPs that show up as srcip (attackers) or dstip (legit destinations)
const ATTACKER_IPS = [
  { ip: '203.0.113.45',   country: 'China' },
  { ip: '185.220.101.7',  country: 'Germany' },
  { ip: '45.143.220.12',  country: 'Russia' },
  { ip: '193.32.162.80',  country: 'Netherlands' },
  { ip: '141.98.11.34',   country: 'Lithuania' },
];
const DEST_IPS = ['8.8.8.8', '1.1.1.1', '140.82.121.4', '52.84.150.20', '104.18.32.7', '13.107.42.14'];
const SSH_USERS = ['root', 'admin', 'oracle', 'postgres', 'ubuntu', 'test', 'git', 'user'];
const WIN_USERS = ['Administrator', 'jtan', 'slee', 'rkumar', 'admin', 'svc_backup', 'akarim'];

// ── device registry (shared NocVault scenario) ──────────────────────────────
// site_id: KL-HQ=1, PEN=2, JB=3
const DEVICES = [
  { host: 'FG-KLHQ-01',      ip: '10.10.0.1',   vendor: 'fortinet', brand: 'Fortinet', model: 'FortiGate-100F', site: 'KL-HQ', site_id: 1, sub: 10, kind: 'firewall' },
  { host: 'FG-PEN-01',       ip: '10.20.0.1',   vendor: 'fortinet', brand: 'Fortinet', model: 'FortiGate-100F', site: 'PEN',   site_id: 2, sub: 20, kind: 'firewall' },
  { host: 'FG-JB-01',        ip: '10.30.0.1',   vendor: 'fortinet', brand: 'Fortinet', model: 'FortiGate-100F', site: 'JB',    site_id: 3, sub: 30, kind: 'firewall' },
  { host: 'SW-KLHQ-CORE-01', ip: '10.10.0.2',   vendor: 'cisco',    brand: 'Cisco',    model: 'Catalyst 9300',  site: 'KL-HQ', site_id: 1, sub: 10, kind: 'switch' },
  { host: 'SW-PEN-CORE-01',  ip: '10.20.0.2',   vendor: 'aruba',    brand: 'Aruba',    model: 'CX 6300',        site: 'PEN',   site_id: 2, sub: 20, kind: 'switch' },
  { host: 'SW-JB-CORE-01',   ip: '10.30.0.2',   vendor: 'aruba',    brand: 'Aruba',    model: 'CX 6300',        site: 'JB',    site_id: 3, sub: 30, kind: 'switch' },
  { host: 'RTR-WAN-01',      ip: '10.10.0.254', vendor: 'cisco',    brand: 'Cisco',    model: 'ISR 4451',       site: 'KL-HQ', site_id: 1, sub: 10, kind: 'router' },
  { host: 'SRV-DC01',        ip: '10.10.1.10',  vendor: 'windows',  brand: 'Microsoft',model: 'Windows Server', site: 'KL-HQ', site_id: 1, sub: 10, kind: 'windows' },
  { host: 'SRV-WEB01',       ip: '10.10.1.20',  vendor: 'generic',  brand: 'Linux',    model: 'Ubuntu 22.04',   site: 'KL-HQ', site_id: 1, sub: 10, kind: 'linux' },
  { host: 'SRV-DB01',        ip: '10.10.1.30',  vendor: 'generic',  brand: 'Linux',    model: 'Ubuntu 22.04',   site: 'KL-HQ', site_id: 1, sub: 10, kind: 'linux' },
];
const byHost = Object.fromEntries(DEVICES.map((d) => [d.host, d]));

// External hosts to register in known_hosts (geo / threat-intel enrichment)
const EXTERNAL_HOSTS = [
  { ip: '203.0.113.45',  hostname: null,             country_code: 'CN', country_name: 'China',       asn_org: 'Chinanet',        bad: true,  abuse: 92 },
  { ip: '185.220.101.7', hostname: null,             country_code: 'DE', country_name: 'Germany',     asn_org: 'Tor Exit Relay',  bad: true,  abuse: 100 },
  { ip: '45.143.220.12', hostname: null,             country_code: 'RU', country_name: 'Russia',      asn_org: 'IP Volume Inc',   bad: true,  abuse: 88 },
  { ip: '193.32.162.80', hostname: null,             country_code: 'NL', country_name: 'Netherlands', asn_org: 'Estoxy OU',       bad: true,  abuse: 74 },
  { ip: '141.98.11.34',  hostname: null,             country_code: 'LT', country_name: 'Lithuania',   asn_org: 'UAB Cherry',      bad: true,  abuse: 67 },
  { ip: '8.8.8.8',       hostname: 'dns.google',     country_code: 'US', country_name: 'United States', asn_org: 'Google LLC',    bad: false, abuse: 0 },
  { ip: '1.1.1.1',       hostname: 'one.one.one.one',country_code: 'US', country_name: 'United States', asn_org: 'Cloudflare',    bad: false, abuse: 0 },
  { ip: '140.82.121.4',  hostname: 'github.com',     country_code: 'US', country_name: 'United States', asn_org: 'GitHub Inc',    bad: false, abuse: 0 },
];

// All IPs that demo rows can use as alert_events.source_ip (for RESET cleanup)
const DEMO_IPS = [...DEVICES.map((d) => d.ip), ...ATTACKER_IPS.map((a) => a.ip)];

// ── FortiGate raw-line helper ───────────────────────────────────────────────
function fgTime(d) {
  return `date=${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `time=${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ============================================================================
// EVENT GENERATORS
// Each returns a partial row: { severity, category, program, facility,
//   facility_label, message, raw_message, sd (structured_data), risk }
// `sd.demo` is added centrally before insert.
// ============================================================================

function genFortinet(dev, d) {
  const devid = `FG100FTK${dev.sub}0012345`;
  return weightedPick([
    // ── traffic allow (the bulk — info/notice) ──────────────────────────────
    [60, () => {
      const src = internalIp(dev.sub), dst = pick(DEST_IPS), svc = pick(['HTTPS', 'HTTP', 'DNS', 'NTP', 'SSH', 'SMTP']);
      const sport = ri(1024, 65000), dport = pick([443, 80, 53, 123, 22, 25]);
      const sent = ri(400, 90000), rcvd = ri(400, 400000);
      return {
        severity: 5, category: 'firewall', facility: 23, facility_label: 'local7',
        message: `traffic forward accept ${src}:${sport} -> ${dst}:${dport} ${svc}`,
        raw_message: `${fgTime(d)} devname="${dev.host}" devid="${devid}" type="traffic" subtype="forward" level="notice" srcip=${src} srcport=${sport} dstip=${dst} dstport=${dport} proto=6 action="accept" service="${svc}" sentbyte=${sent} rcvdbyte=${rcvd} policyid=${ri(1, 40)}`,
        sd: { type: 'traffic', subtype: 'forward', category: 'firewall', action: 'accept', srcip: src, dstip: dst, service: svc, proto: '6', dstport: String(dport) },
        risk: 0,
      };
    }],
    // ── traffic deny (Security tab top-blocked) ─────────────────────────────
    [16, () => {
      const inbound = chance(0.5);
      const src = inbound ? pick(ATTACKER_IPS).ip : internalIp(dev.sub);
      const dst = inbound ? internalIp(dev.sub) : pick(DEST_IPS);
      const svc = pick(['HTTPS', 'TELNET', 'SSH', 'RDP', 'SMB', 'MS-SQL', 'unknown']);
      const dport = pick([3389, 445, 22, 23, 1433, 8080, 5900]);
      return {
        severity: 4, category: 'firewall', facility: 23, facility_label: 'local7',
        message: `traffic forward deny ${src} -> ${dst}:${dport} ${svc}`,
        raw_message: `${fgTime(d)} devname="${dev.host}" devid="${devid}" type="traffic" subtype="forward" level="warning" srcip=${src} dstip=${dst} dstport=${dport} proto=6 action="deny" service="${svc}" policyid=0 msg="Connection denied by policy"`,
        sd: { type: 'traffic', subtype: 'forward', category: 'firewall', action: 'deny', srcip: src, dstip: dst, service: svc, proto: '6', dstport: String(dport), msg: 'Connection denied by policy' },
        risk: ri(45, 70),
      };
    }],
    // ── VPN tunnel up / down ────────────────────────────────────────────────
    [8, () => {
      const up = chance(0.6);
      const rem = pick(ATTACKER_IPS).ip;
      const user = pick(['jtan', 'slee', 'rkumar', 'akarim', 'vpnuser']);
      return {
        severity: up ? 5 : 3, category: 'vpn', facility: 23, facility_label: 'local7',
        message: `ssl-vpn tunnel ${up ? 'up' : 'down'} user=${user} remip=${rem}`,
        raw_message: `${fgTime(d)} devname="${dev.host}" devid="${devid}" type="event" subtype="vpn" level="${up ? 'notice' : 'error'}" action="${up ? 'tunnel-up' : 'tunnel-down'}" user="${user}" remip=${rem} tunneltype="ssl-web" msg="SSL VPN tunnel ${up ? 'established' : 'closed'}"`,
        sd: { type: 'event', subtype: 'vpn', category: 'vpn', action: up ? 'tunnel-up' : 'tunnel-down', user, srcip: rem, remip: rem, msg: `SSL VPN tunnel ${up ? 'established' : 'closed'}` },
        risk: up ? 5 : 20,
      };
    }],
    // ── SSL-VPN login failure (attacker) — Security tab / brute force ────────
    [9, () => {
      const a = pick(ATTACKER_IPS);
      const user = pick(SSH_USERS);
      return {
        severity: 3, category: 'vpn', facility: 23, facility_label: 'local7',
        message: `ssl-vpn login failed user=${user} from ${a.ip}`,
        raw_message: `${fgTime(d)} devname="${dev.host}" devid="${devid}" type="event" subtype="vpn" level="error" action="ssl-login-fail" user="${user}" remip=${a.ip} srccountry="${a.country}" reason="sslvpn_login_permission_denied" msg="SSL VPN login fail"`,
        sd: { type: 'event', subtype: 'vpn', category: 'vpn', subcategory: 'login_failed', action: 'ssl-login-fail', user, srcip: a.ip, remip: a.ip, srccountry: a.country, reason: 'sslvpn_login_permission_denied', msg: 'SSL VPN login fail' },
        risk: ri(55, 80),
      };
    }],
    // ── admin login success ─────────────────────────────────────────────────
    [4, () => {
      const src = internalIp(dev.sub);
      return {
        severity: 5, category: 'authentication', facility: 23, facility_label: 'local7',
        message: `admin login successful user=admin from ${src}`,
        raw_message: `${fgTime(d)} devname="${dev.host}" devid="${devid}" type="event" subtype="system" level="notice" action="login" user="admin" srcip=${src} ui="https(${src})" msg="Administrator admin logged in successfully"`,
        sd: { type: 'event', subtype: 'system', category: 'authentication', subcategory: 'login_success', action: 'login', user: 'admin', srcip: src, msg: 'Administrator admin logged in successfully' },
        risk: 10,
      };
    }],
    // ── UTM / IPS detection (Security tab) ──────────────────────────────────
    [3, () => {
      const a = pick(ATTACKER_IPS);
      const dst = internalIp(dev.sub);
      const attack = pick(['Backdoor.Double.Pulsar', 'SQL.Injection', 'Apache.Log4j.Error.Log.Remote.Code.Execution', 'MS.SMB.Server.SMB1.Trans2.Secondary.Handling.Code.Execution']);
      return {
        severity: 2, category: 'security', facility: 23, facility_label: 'local7',
        message: `ips signature detected ${attack} from ${a.ip}`,
        raw_message: `${fgTime(d)} devname="${dev.host}" devid="${devid}" type="utm" subtype="ips" level="critical" srcip=${a.ip} dstip=${dst} srccountry="${a.country}" attack="${attack}" action="dropped" severity="critical" msg="IPS signature matched"`,
        sd: { type: 'utm', subtype: 'ips', category: 'security', action: 'dropped', srcip: a.ip, dstip: dst, srccountry: a.country, attack, severity: 'critical', msg: 'IPS signature matched' },
        risk: ri(75, 95),
      };
    }],
  ])();
}

function genCisco(dev, d) {
  const seq = ri(100000, 999999);
  return weightedPick([
    // interface up/down
    [22, () => {
      const intf = `GigabitEthernet1/0/${ri(1, 48)}`;
      const down = chance(0.45);
      return {
        severity: down ? 3 : 5, category: 'interface', facility: 23, facility_label: 'local7',
        message: `%LINK-3-UPDOWN: Interface ${intf}, changed state to ${down ? 'down' : 'up'}`,
        raw_message: `${seq}: ${dev.host}: %LINK-3-UPDOWN: Interface ${intf}, changed state to ${down ? 'down' : 'up'}`,
        sd: { category: 'interface', subcategory: 'link_change', interface: intf, link_state: down ? 'down' : 'up' },
        risk: down ? 25 : 0,
      };
    }],
    // line protocol
    [14, () => {
      const intf = `GigabitEthernet1/0/${ri(1, 48)}`;
      const down = chance(0.4);
      return {
        severity: down ? 3 : 5, category: 'interface', facility: 23, facility_label: 'local7',
        message: `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${intf}, changed state to ${down ? 'down' : 'up'}`,
        raw_message: `${seq}: ${dev.host}: %LINEPROTO-5-UPDOWN: Line protocol on Interface ${intf}, changed state to ${down ? 'down' : 'up'}`,
        sd: { category: 'interface', subcategory: 'link_change', interface: intf, link_state: down ? 'down' : 'up' },
        risk: down ? 20 : 0,
      };
    }],
    // OSPF adjacency change (routing)
    [10, () => {
      const nbr = pick(DEVICES.filter((x) => x.vendor === 'cisco' && x.host !== dev.host)).ip;
      const intf = `GigabitEthernet0/${ri(0, 3)}`;
      const states = chance(0.5) ? 'LOADING to FULL' : 'FULL to DOWN';
      const down = states.includes('DOWN');
      return {
        severity: down ? 3 : 5, category: 'routing', facility: 23, facility_label: 'local7',
        message: `%OSPF-5-ADJCHG: Process 1, Nbr ${nbr} on ${intf} from ${states}`,
        raw_message: `${seq}: ${dev.host}: %OSPF-5-ADJCHG: Process 1, Nbr ${nbr} on ${intf} from ${states}, ${down ? 'Dead timer expired' : 'Loading Done'}`,
        sd: { category: 'routing', subcategory: 'ospf', interface: intf, neighbor: nbr },
        risk: down ? 30 : 0,
      };
    }],
    // BGP neighbor change (routing)
    [6, () => {
      const nbr = pick(DEVICES.filter((x) => x.vendor === 'fortinet')).ip;
      const down = chance(0.5);
      return {
        severity: down ? 3 : 5, category: 'routing', facility: 23, facility_label: 'local7',
        message: `%BGP-5-ADJCHANGE: neighbor ${nbr} ${down ? 'Down BGP Notification sent' : 'Up'}`,
        raw_message: `${seq}: ${dev.host}: %BGP-5-ADJCHANGE: neighbor ${nbr} ${down ? 'Down BGP Notification sent - hold time expired' : 'Up'}`,
        sd: { category: 'routing', subcategory: 'bgp', neighbor: nbr },
        risk: down ? 35 : 0,
      };
    }],
    // config change
    [8, () => {
      const who = pick(['admin', 'netops', 'jtan']);
      const via = pick(['console', `vty0 (${internalIp(dev.sub)})`]);
      return {
        severity: 5, category: 'configuration', facility: 23, facility_label: 'local7',
        message: `%SYS-5-CONFIG_I: Configured from ${via} by ${who}`,
        raw_message: `${seq}: ${dev.host}: %SYS-5-CONFIG_I: Configured from ${via} by ${who}`,
        sd: { category: 'configuration', subcategory: 'config_change', user: who },
        risk: 15,
      };
    }],
    // port-security violation (security)
    [4, () => {
      const intf = `GigabitEthernet1/0/${ri(1, 48)}`;
      const mac = `${ri(16, 99)}ab.${ri(1000, 9999)}.${ri(1000, 9999)}`;
      return {
        severity: 2, category: 'security', facility: 23, facility_label: 'local7',
        message: `%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation on ${intf}, MAC ${mac}`,
        raw_message: `${seq}: ${dev.host}: %PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${mac} on port ${intf}`,
        sd: { category: 'security', subcategory: 'port_security', interface: intf, mac_address: mac },
        risk: ri(50, 70),
      };
    }],
    // MAC flap (stp/loop)
    [4, () => {
      const mac = `${ri(16, 99)}ab.${ri(1000, 9999)}.${ri(1000, 9999)}`;
      const i1 = `Gi1/0/${ri(1, 24)}`, i2 = `Gi1/0/${ri(25, 48)}`;
      return {
        severity: 4, category: 'network', facility: 23, facility_label: 'local7',
        message: `%SW_MATM-4-MACFLAP_NOTIF: Host ${mac} in vlan 10 is flapping between ${i1} and ${i2}`,
        raw_message: `${seq}: ${dev.host}: %SW_MATM-4-MACFLAP_NOTIF: Host ${mac} in vlan 10 is flapping between port ${i1} and port ${i2}`,
        sd: { category: 'stp', subcategory: 'mac_flap', mac_address: mac, interface: i1 },
        risk: 30,
      };
    }],
  ])();
}

function genAruba(dev, d) {
  return weightedPick([
    // port up/down
    [30, () => {
      const port = `1/1/${ri(1, 48)}`;
      const down = chance(0.4);
      return {
        severity: down ? 4 : 5, category: 'interface', facility: 23, facility_label: 'local7',
        message: `LLDP-3-PORT: Port ${port} is now ${down ? 'down' : 'up'}`,
        raw_message: `<29>1 ${d.toISOString()} ${dev.host} ports - - - Port ${port} transitioned to ${down ? 'down' : 'up'} state`,
        sd: { category: 'interface', subcategory: 'link_change', interface: port, link_state: down ? 'down' : 'up' },
        risk: down ? 20 : 0,
      };
    }],
    // auth (802.1X) — Aruba auth-failed feeds the Security tab aruba widget
    [12, () => {
      const port = `1/1/${ri(1, 48)}`;
      const mac = `${ri(10, 99)}:${ri(10, 99)}:${ri(10, 99)}:${ri(10, 99)}:${ri(10, 99)}:${ri(10, 99)}`;
      const fail = chance(0.5);
      return {
        severity: fail ? 4 : 5, category: 'authentication', facility: 23, facility_label: 'local7',
        message: `dot1x authentication ${fail ? 'failed' : 'succeeded'} on ${port} client ${mac}`,
        raw_message: `<30>1 ${d.toISOString()} ${dev.host} dot1x - - - User authentication ${fail ? 'failed' : 'succeeded'} for client ${mac} on port ${port}`,
        sd: { category: 'authentication', subcategory: fail ? 'auth_failed' : 'login_success', interface: port, mac_address: mac },
        risk: fail ? 35 : 0,
      };
    }],
    // config / system
    [8, () => {
      const who = pick(['admin', 'netops']);
      return {
        severity: 5, category: 'configuration', facility: 23, facility_label: 'local7',
        message: `cli-session config committed by ${who}`,
        raw_message: `<29>1 ${d.toISOString()} ${dev.host} cli - - - Configuration changes committed by user ${who} via SSH`,
        sd: { category: 'configuration', subcategory: 'config_change', user: who },
        risk: 12,
      };
    }],
    // PoE / system notice
    [10, () => {
      const port = `1/1/${ri(1, 48)}`;
      return {
        severity: 6, category: 'system', facility: 23, facility_label: 'local7',
        message: `poe power delivered on ${port}`,
        raw_message: `<30>1 ${d.toISOString()} ${dev.host} poe - - - PoE power applied to port ${port}, class 4`,
        sd: { category: 'system', subcategory: 'poe', interface: port },
        risk: 0,
      };
    }],
  ])();
}

function genWindows(dev, d) {
  return weightedPick([
    // 4624 success logon
    [30, () => {
      const user = pick(WIN_USERS), src = internalIp(dev.sub);
      const lt = pick(['3 (Network)', '2 (Interactive)', '10 (RemoteInteractive)']);
      return {
        severity: 6, category: 'authentication', facility: 4, facility_label: 'auth',
        message: `EventID 4624 An account was successfully logged on - ${user}`,
        raw_message: `${dev.host} MSWinEventLog Security 4624 An account was successfully logged on. Subject Account Name: ${user} Logon Type: ${lt} Source Network Address: ${src}`,
        sd: { category: 'authentication', subcategory: 'login_success', event_id: '4624', user, srcip: src, logon_type: lt },
        risk: 0,
      };
    }],
    // 4625 failed logon (attacker or internal typo)
    [14, () => {
      const ext = chance(0.5);
      const a = ext ? pick(ATTACKER_IPS) : null;
      const src = ext ? a.ip : internalIp(dev.sub);
      const user = pick(WIN_USERS);
      return {
        severity: 4, category: 'authentication', facility: 4, facility_label: 'auth',
        message: `EventID 4625 An account failed to log on - ${user}`,
        raw_message: `${dev.host} MSWinEventLog Security 4625 An account failed to log on. Account Name: ${user} Failure Reason: Unknown user name or bad password. Source Network Address: ${src} Logon Type: 3`,
        sd: { category: 'authentication', subcategory: 'login_failed', event_id: '4625', user, srcip: src, ...(ext ? { srccountry: a.country } : {}), reason: 'bad password' },
        risk: ext ? ri(50, 75) : ri(25, 40),
      };
    }],
    // 4768/4769 kerberos + 4634 logoff + system
    [10, () => {
      const user = pick(WIN_USERS);
      return {
        severity: 6, category: 'authentication', facility: 4, facility_label: 'auth',
        message: `EventID 4634 An account was logged off - ${user}`,
        raw_message: `${dev.host} MSWinEventLog Security 4634 An account was logged off. Account Name: ${user} Logon Type: 3`,
        sd: { category: 'authentication', subcategory: 'logoff', event_id: '4634', user },
        risk: 0,
      };
    }],
    // AD / system service
    [8, () => {
      return {
        severity: 6, category: 'system', facility: 4, facility_label: 'auth',
        message: `EventID 5773 Netlogon DNS records registered`,
        raw_message: `${dev.host} MSWinEventLog System 5773 The dynamic registration of the DNS records for the domain controller succeeded`,
        sd: { category: 'system', subcategory: 'service', event_id: '5773' },
        risk: 0,
      };
    }],
  ])();
}

function genLinux(dev, d) {
  const pid = ri(800, 30000);
  return weightedPick([
    // sshd accepted
    [22, () => {
      const user = pick(['ubuntu', 'deploy', 'jtan', 'svc_app']), src = internalIp(dev.sub);
      return {
        severity: 6, category: 'authentication', facility: 4, facility_label: 'auth', program: 'sshd', pid,
        message: `Accepted password for ${user} from ${src} port ${ri(40000, 60000)} ssh2`,
        raw_message: `${dev.host} sshd[${pid}]: Accepted password for ${user} from ${src} port ${ri(40000, 60000)} ssh2`,
        sd: { category: 'authentication', subcategory: 'login_success', user, srcip: src },
        risk: 0,
      };
    }],
    // sshd failed (attacker brute force)
    [16, () => {
      const a = pick(ATTACKER_IPS), user = pick(SSH_USERS);
      const invalid = chance(0.6);
      return {
        severity: 4, category: 'authentication', facility: 4, facility_label: 'auth', program: 'sshd', pid,
        message: `Failed password for ${invalid ? 'invalid user ' : ''}${user} from ${a.ip} port ${ri(40000, 60000)} ssh2`,
        raw_message: `${dev.host} sshd[${pid}]: Failed password for ${invalid ? 'invalid user ' : ''}${user} from ${a.ip} port ${ri(40000, 60000)} ssh2`,
        sd: { category: 'authentication', subcategory: 'login_failed', user, srcip: a.ip, srccountry: a.country },
        risk: ri(45, 70),
      };
    }],
    // web access (WEB01)
    [12, () => {
      const code = weightedPick([[70, 200], [10, 301], [8, 404], [6, 500], [6, 403]]);
      const path = pick(['/', '/login', '/api/health', '/wp-admin.php', '/.env', '/admin', '/static/app.js']);
      const src = chance(0.4) ? pick(ATTACKER_IPS).ip : internalIp(dev.sub);
      return {
        severity: code >= 500 ? 4 : 6, category: 'web', facility: 4, facility_label: 'auth', program: 'nginx', pid,
        message: `${src} "GET ${path} HTTP/1.1" ${code}`,
        raw_message: `${dev.host} nginx: ${src} - - [${d.toISOString()}] "GET ${path} HTTP/1.1" ${code} ${ri(120, 48000)} "-" "Mozilla/5.0"`,
        sd: { category: 'web', srcip: src, status: String(code), url: path },
        risk: code >= 500 ? 20 : (path.includes('.env') || path.includes('wp-admin') ? 40 : 0),
      };
    }],
    // cron / systemd / kernel
    [10, () => {
      const opts = [
        { p: 'CRON', m: `(root) CMD (/usr/bin/backup.sh)`, c: 'system' },
        { p: 'systemd', m: `Started Session ${ri(100, 999)} of user ${pick(['ubuntu', 'deploy'])}`, c: 'system' },
        { p: 'kernel', m: `[UFW BLOCK] IN=eth0 SRC=${pick(ATTACKER_IPS).ip} DST=${dev.ip} PROTO=TCP DPT=${pick([22, 3306, 80])}`, c: 'firewall' },
      ];
      const o = pick(opts);
      return {
        severity: o.p === 'kernel' ? 4 : 6, category: o.c, facility: o.p === 'CRON' ? 9 : 4, facility_label: o.p === 'CRON' ? 'cron' : 'auth', program: o.p, pid,
        message: o.m,
        raw_message: `${dev.host} ${o.p}[${pid}]: ${o.m}`,
        sd: { category: o.c, program: o.p },
        risk: o.p === 'kernel' ? 25 : 0,
      };
    }],
  ])();
}

const GEN_BY_VENDOR = {
  fortinet: genFortinet,
  cisco:    genCisco,
  aruba:    genAruba,
  windows:  genWindows,
  generic:  genLinux,
};

// Device selection weights — firewalls + core switches are the busiest emitters.
const DEVICE_WEIGHTS = DEVICES.map((d) => {
  const w = d.kind === 'firewall' ? 26 : d.kind === 'switch' ? 14 : d.kind === 'router' ? 10 : d.kind === 'windows' ? 9 : 8;
  return [w, d];
});

// ── hour-of-day weighting (busier during work hours, lighter on weekends) ────
const HOUR_WEIGHT = [
  1, 1, 1, 1, 1, 2,   // 00-05
  3, 5, 8, 10, 10, 9, // 06-11
  8, 9, 10, 10, 9, 7, // 12-17
  5, 4, 3, 2, 2, 1,   // 18-23
];
const MAX_HOUR_WEIGHT = 10;

function randomTimestamp() {
  const now = Date.now();
  const windowMs = DAYS * 24 * 60 * 60 * 1000;
  // rejection sampling shaped by hour-of-day + weekday factor
  for (let i = 0; i < 40; i++) {
    const t = now - Math.floor(Math.random() * windowMs);
    const d = new Date(t);
    const dow = d.getDay(); // 0=Sun 6=Sat
    const dayFactor = (dow === 0 || dow === 6) ? 0.4 : 1;
    const w = HOUR_WEIGHT[d.getHours()] * dayFactor;
    if (Math.random() < w / MAX_HOUR_WEIGHT) return d;
  }
  return new Date(now - Math.floor(Math.random() * windowMs));
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const client = new Client(conn);
  await client.connect();
  console.log(`[logvault-seed] connected to ${conn.user}@${conn.host}:${conn.port}/${conn.database}`);
  console.log(`[logvault-seed] TOTAL=${TOTAL}  DAYS=${DAYS}  VOLUME=${VOLUME}  RESET=${RESET}`);

  const summary = {};

  // ── 0) try to pre-create daily partitions for the history window ──────────
  // syslog_entries is RANGE-partitioned by received_at. ensure_syslog_partitions
  // only covers today forward, so create the past DAYS days here. If the table is
  // not partitioned (older install) or a partition overlaps, the per-day try/
  // catch swallows it and rows fall through to syslog_entries_default.
  let partsCreated = 0;
  for (let i = 0; i <= DAYS + 1; i++) {
    const day = new Date(Date.now() - i * 86400000);
    const y = day.getFullYear(), m = pad2(day.getMonth() + 1), dd = pad2(day.getDate());
    const name = `syslog_entries_p${y}${m}${dd}`;
    const from = `${y}-${m}-${dd}`;
    const to = new Date(day.getTime() + 86400000);
    const toStr = `${to.getFullYear()}-${pad2(to.getMonth() + 1)}-${pad2(to.getDate())}`;
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF syslog_entries FOR VALUES FROM ('${from}') TO ('${toStr}')`
      );
      partsCreated++;
    } catch (e) { /* overlap / not-partitioned — fine, default partition catches rows */ }
  }
  console.log(`[logvault-seed] daily partitions ensured (${partsCreated} create attempts ok)`);

  // ── 1) RESET (delete demo rows only) ──────────────────────────────────────
  if (RESET) {
    const r1 = await client.query(`DELETE FROM syslog_entries WHERE structured_data->>'demo' = 'true'`);
    let r2 = { rowCount: 0 }, r3 = { rowCount: 0 }, r4 = { rowCount: 0 };
    try { r2 = await client.query(`DELETE FROM alert_events  WHERE source_ip = ANY($1::inet[])`, [DEMO_IPS]); } catch (e) { console.warn('  alert_events reset skipped:', e.message); }
    try { r3 = await client.query(`DELETE FROM anomaly_events WHERE detail->>'demo' = 'true'`); } catch (e) { console.warn('  anomaly_events reset skipped:', e.message); }
    try { r4 = await client.query(`DELETE FROM entity_risk    WHERE entity_value = ANY($1::text[])`, [[...DEVICES.map((d) => d.host), ...ATTACKER_IPS.map((a) => a.ip)]]); } catch (e) { console.warn('  entity_risk reset skipped:', e.message); }
    console.log(`[logvault-seed] RESET removed: syslog_entries=${r1.rowCount}, alert_events=${r2.rowCount}, anomaly_events=${r3.rowCount}, entity_risk=${r4.rowCount}`);
  }

  // ── 2) known_hosts (device registry + external enrichment) ────────────────
  let khCount = 0;
  for (const d of DEVICES) {
    await client.query(
      `INSERT INTO known_hosts
         (ip_address, hostname, vendor, description, last_seen, created_at,
          site_name, brand, model, device_status, lifecycle_status, site_id,
          synced_from_nv, last_synced, is_external)
       VALUES ($1,$2,$3,$4,NOW(),NOW(),$5,$6,$7,'active','in_service',$8,TRUE,NOW(),FALSE)
       ON CONFLICT (ip_address) DO UPDATE SET
         hostname=EXCLUDED.hostname, vendor=EXCLUDED.vendor, description=EXCLUDED.description,
         last_seen=NOW(), site_name=EXCLUDED.site_name, brand=EXCLUDED.brand,
         model=EXCLUDED.model, device_status=EXCLUDED.device_status,
         lifecycle_status=EXCLUDED.lifecycle_status, site_id=EXCLUDED.site_id,
         synced_from_nv=TRUE, last_synced=NOW()`,
      [d.ip, d.host, d.vendor, `${d.brand} ${d.model} @ ${d.site}`, d.site, d.brand, d.model, d.site_id]
    );
    khCount++;
  }
  for (const h of EXTERNAL_HOSTS) {
    await client.query(
      `INSERT INTO known_hosts
         (ip_address, hostname, description, last_seen, created_at,
          is_external, country_code, country_name, asn_org,
          abuse_score, is_known_bad, threat_tags, last_enriched)
       VALUES ($1,$2,$3,NOW(),NOW(),TRUE,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (ip_address) DO UPDATE SET
         hostname=COALESCE(EXCLUDED.hostname, known_hosts.hostname),
         is_external=TRUE, country_code=EXCLUDED.country_code,
         country_name=EXCLUDED.country_name, asn_org=EXCLUDED.asn_org,
         abuse_score=EXCLUDED.abuse_score, is_known_bad=EXCLUDED.is_known_bad,
         threat_tags=EXCLUDED.threat_tags, last_enriched=NOW()`,
      [h.ip, h.hostname, `${h.country_name}${h.bad ? ' (known-bad)' : ''}`, h.country_code,
       h.country_name, h.asn_org, h.abuse, h.bad, h.bad ? ['malicious', 'scanner'] : null]
    );
    khCount++;
  }
  summary.known_hosts = khCount;
  console.log(`[logvault-seed] known_hosts upserted: ${khCount}`);

  // ── 3) syslog_entries time-series ─────────────────────────────────────────
  const COLS = `(received_at, log_timestamp, source_ip, source_host, facility, severity,
     severity_label, facility_label, vendor, program, message, raw_message,
     structured_data, is_parsed, category, risk_score, prev_hash, entry_hash)`;

  let inserted = 0;
  let batchRows = [];

  async function flush() {
    if (batchRows.length === 0) return;
    const values = [];
    const params = [];
    let p = 1;
    for (const row of batchRows) {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        row.received_at, row.log_timestamp, row.source_ip, row.source_host,
        row.facility, row.severity, row.severity_label, row.facility_label,
        row.vendor, row.program, row.message, row.raw_message,
        JSON.stringify(row.sd), true, row.category, row.risk_score, null, null
      );
    }
    await client.query(`INSERT INTO syslog_entries ${COLS} VALUES ${values.join(',')}`, params);
    inserted += batchRows.length;
    batchRows = [];
  }

  for (let i = 0; i < TOTAL; i++) {
    const dev = weightedPick(DEVICE_WEIGHTS);
    const ts = randomTimestamp();
    const ev = GEN_BY_VENDOR[dev.vendor](dev, ts);
    ev.sd.demo = 'true';
    ev.sd.site = dev.site;
    batchRows.push({
      received_at:    ts,
      log_timestamp:  ts,
      source_ip:      dev.ip,
      source_host:    dev.host,
      facility:       ev.facility != null ? ev.facility : 23,
      severity:       ev.severity,
      severity_label: sevLabel(ev.severity),
      facility_label: ev.facility_label || 'local7',
      vendor:         dev.vendor,
      program:        ev.program || null,
      message:        ev.message,
      raw_message:    ev.raw_message,
      sd:             ev.sd,
      category:       ev.category,
      risk_score:     ev.risk || 0,
    });
    if (batchRows.length >= BATCH_ROWS) await flush();
  }
  await flush();
  summary.syslog_entries = inserted;
  console.log(`[logvault-seed] syslog_entries inserted: ${inserted}`);

  // ── 4) alert_events (attach to existing seeded alert_rules) ───────────────
  let alertCount = 0;
  try {
    const { rows: rules } = await client.query(`SELECT id, name FROM alert_rules`);
    const ruleByName = Object.fromEntries(rules.map((r) => [r.name, r.id]));
    const aeRows = [
      { rule: 'Auth Failures',      host: 'SRV-WEB01', ip: '203.0.113.45',  cnt: 47, msg: 'Failed password for invalid user root from 203.0.113.45 port 51344 ssh2', ack: false },
      { rule: 'Auth Failures',      host: 'FG-KLHQ-01', ip: '185.220.101.7', cnt: 31, msg: 'ssl-vpn login failed user=admin from 185.220.101.7 (login fail)', ack: false },
      { rule: 'Auth Failures',      host: 'SRV-DC01',  ip: '45.143.220.12',  cnt: 22, msg: 'EventID 4625 An account failed to log on - Administrator (bad password)', ack: true },
      { rule: 'Critical Threshold', host: 'FG-PEN-01', ip: '193.32.162.80',  cnt: 8,  msg: 'ips signature detected Backdoor.Double.Pulsar from 193.32.162.80', ack: false },
      { rule: 'Critical Threshold', host: 'SW-KLHQ-CORE-01', ip: '10.10.0.2',cnt: 6,  msg: '%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation on Gi1/0/12', ack: true },
      { rule: 'Emergency Events',   host: 'RTR-WAN-01', ip: '10.10.0.254',   cnt: 1,  msg: '%BGP-5-ADJCHANGE: neighbor 10.30.0.1 Down BGP Notification sent - hold time expired', ack: false },
    ];
    for (const a of aeRows) {
      const rid = ruleByName[a.rule];
      if (!rid) continue;
      const firedAt = new Date(Date.now() - ri(1, DAYS * 24) * 3600000);
      await client.query(
        `INSERT INTO alert_events (rule_id, fired_at, source_host, source_ip, match_count, sample_message, acknowledged, acknowledged_at, acknowledged_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rid, firedAt, a.host, a.ip, a.cnt, a.msg, a.ack, a.ack ? new Date(firedAt.getTime() + 1800000) : null, a.ack ? 'demo-seed' : null]
      );
      alertCount++;
    }
    summary.alert_events = alertCount;
    console.log(`[logvault-seed] alert_events inserted: ${alertCount}`);
  } catch (e) {
    console.warn('[logvault-seed] alert_events skipped:', e.message);
  }

  // ── 5) anomaly_events (UEBA / Security tab) ───────────────────────────────
  let anomCount = 0;
  try {
    const anomalies = [
      { et: 'device', ev: 'SRV-WEB01', ip: '10.10.1.20',  type: 'volume_spike', sev: 'warning',  score: 78, title: 'Event volume 6x above baseline on SRV-WEB01' },
      { et: 'srcip',  ev: '203.0.113.45', ip: '203.0.113.45', type: 'new_geo',   sev: 'critical', score: 91, title: 'First-seen source from China (203.0.113.45)' },
      { et: 'user',   ev: 'admin',      ip: null,         type: 'new_service',  sev: 'warning',  score: 64, title: 'User admin authenticated to a new device' },
      { et: 'device', ev: 'FG-PEN-01',  ip: '10.20.0.1',  type: 'volume_spike', sev: 'info',     score: 41, title: 'Mild deny-traffic increase on FG-PEN-01' },
      { et: 'device', ev: 'SW-JB-CORE-01', ip: '10.30.0.2', type: 'silent',     sev: 'warning',  score: 55, title: 'SW-JB-CORE-01 stopped logging for 3h' },
    ];
    for (const x of anomalies) {
      const detectedAt = new Date(Date.now() - ri(1, 36) * 3600000);
      await client.query(
        `INSERT INTO anomaly_events (detected_at, entity_type, entity_value, source_ip, anomaly_type, severity, score, title, detail, acknowledged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)`,
        [detectedAt, x.et, x.ev, x.ip, x.type, x.sev, x.score, x.title, JSON.stringify({ demo: 'true', baseline_window_days: 7 })]
      );
      anomCount++;
    }
    summary.anomaly_events = anomCount;
    console.log(`[logvault-seed] anomaly_events inserted: ${anomCount}`);
  } catch (e) {
    console.warn('[logvault-seed] anomaly_events skipped:', e.message);
  }

  // ── 6) entity_risk (UEBA leaderboard) ─────────────────────────────────────
  let riskCount = 0;
  try {
    const risks = [
      { et: 'srcip',  ev: '185.220.101.7', ip: '185.220.101.7', score: 94, ev_cnt: 312, an_cnt: 4, factors: [{ label: 'Repeated VPN login failures', contribution: 50 }, { label: 'Tor exit relay', contribution: 30 }, { label: 'New geo', contribution: 14 }] },
      { et: 'srcip',  ev: '203.0.113.45',  ip: '203.0.113.45',  score: 88, ev_cnt: 247, an_cnt: 3, factors: [{ label: 'SSH brute force', contribution: 55 }, { label: 'Known-bad IP', contribution: 33 }] },
      { et: 'device', ev: 'SRV-WEB01',     ip: '10.10.1.20',    score: 61, ev_cnt: 540, an_cnt: 2, factors: [{ label: 'Inbound brute force target', contribution: 40 }, { label: 'Volume spike', contribution: 21 }] },
      { et: 'user',   ev: 'admin',         ip: null,            score: 47, ev_cnt: 88,  an_cnt: 1, factors: [{ label: 'Privileged account', contribution: 30 }, { label: 'New device access', contribution: 17 }] },
    ];
    for (const x of risks) {
      const last = new Date(Date.now() - ri(1, 12) * 3600000);
      await client.query(
        `INSERT INTO entity_risk (entity_type, entity_value, source_ip, risk_score, factors, event_count, anomaly_count, last_activity, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (entity_type, entity_value) DO UPDATE SET
           source_ip=EXCLUDED.source_ip, risk_score=EXCLUDED.risk_score, factors=EXCLUDED.factors,
           event_count=EXCLUDED.event_count, anomaly_count=EXCLUDED.anomaly_count,
           last_activity=EXCLUDED.last_activity, updated_at=NOW()`,
        [x.et, x.ev, x.ip, x.score, JSON.stringify(x.factors), x.ev_cnt, x.an_cnt, last]
      );
      riskCount++;
    }
    summary.entity_risk = riskCount;
    console.log(`[logvault-seed] entity_risk upserted: ${riskCount}`);
  } catch (e) {
    console.warn('[logvault-seed] entity_risk skipped:', e.message);
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log('\n========== DEMO SEED SUMMARY ==========');
  for (const [t, n] of Object.entries(summary)) {
    console.log(`  ${t.padEnd(16)} ${n}`);
  }
  console.log('=======================================');

  await client.end();
  console.log('[logvault-seed] done.');
}

main().catch((err) => {
  console.error('[logvault-seed] FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
