'use strict';
/**
 * modules/span/snmp.js — SNMP transport (plan path + legacy metric path).
 *
 * Extracted verbatim from the legacy SpanVault agent, preserving byte-for-byte
 * on-wire behaviour:
 *  - createSnmpSession()   agent.js:642-661 — v3 authPriv/authNoPriv/noAuthNoPriv
 *    ladder (AuthProtocols.sha, PrivProtocols.aes), v1 vs v2c, timeout:3000,
 *    retries:1, port||161.
 *  - runSnmpPlan()         agent.js:470-528 — server-pushed fetch plan → ships
 *    EXACTLY { type:'snmp_batch', device_id, ts:ISO, walks:{base:[{oid,value}]},
 *    gets:{oid:value} } with the `enc` Buffer sentinel ({ b: base64 }); walks via
 *    session.subtree(base,20,…), gets chunked 16 OIDs/call.
 *  - doSnmp()              agent.js:559-740 — legacy per-metric path for old
 *    servers that push no plan: emits individual
 *    { type:'snmp_result', device_id, ts, oid, metric_name, value }.
 */
const snmp = require('net-snmp');

// ── Legacy metric OIDs (agent.js:559-565) ─────────────────────
const SNMP_OID = {
  sys_object_id: '1.3.6.1.2.1.1.2.0',
  cpu_pct:   '1.3.6.1.2.1.25.3.3.1.2.1',
  mem_used:  '1.3.6.1.2.1.25.2.3.1.6.1',
  mem_total: '1.3.6.1.2.1.25.2.3.1.5.1',
  uptime:    '1.3.6.1.2.1.1.3.0',
};

// Vendor CPU/memory OIDs keyed by SNMP enterprise number (agent.js:571-579).
const VENDOR_SNMP = {
  // HP / Aruba ProCurve / ArubaOS-Switch (STATISTICS-MIB + hpLocalMem)
  11: {
    name: 'HP/Aruba ProCurve',
    cpu:      '1.3.6.1.4.1.11.2.14.11.5.1.9.6.1.0',       // hpSwitchCpuStat (%)
    memTotal: '1.3.6.1.4.1.11.2.14.11.5.1.1.2.1.1.1.5.1', // hpLocalMemTotalBytes
    memFree:  '1.3.6.1.4.1.11.2.14.11.5.1.1.2.1.1.1.6.1', // hpLocalMemFreeBytes
  },
};

// ── SNMP session build (agent.js:642-661) ─────────────────────
// Build a version-aware SNMP session (matches collector/snmp-session.js so v3
// devices assigned to an agent poll identically to locally-polled ones).
function createSnmpSession(device) {
  const port = device.snmp_port || 161;
  const opts = { port, timeout: 3000, retries: 1 };
  if (String(device.snmp_version) === '3') {
    opts.version = snmp.Version3;
    const user = {
      name: device.snmp_v3_user || '',
      level: device.snmp_v3_priv_pass
        ? snmp.SecurityLevel.authPriv
        : (device.snmp_v3_auth_pass ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv),
      authProtocol: snmp.AuthProtocols.sha,
      authKey: device.snmp_v3_auth_pass || undefined,
      privProtocol: snmp.PrivProtocols.aes,
      privKey: device.snmp_v3_priv_pass || undefined,
    };
    return snmp.createV3Session(device.ip_address, user, opts);
  }
  opts.version = String(device.snmp_version) === '1' ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(device.ip_address, device.snmp_community || 'public', opts);
}

// ── Plan-path helpers (agent.js:470-497) ──────────────────────
// Raw subtree walk → [{oid, value}] (best-effort, never rejects).
function snmpWalkRaw(session, baseOid) {
  return new Promise((resolve) => {
    const out = [];
    try {
      session.subtree(baseOid, 20, (vbs) => {
        for (const vb of vbs || []) {
          if (!snmp.isVarbindError(vb)) out.push({ oid: vb.oid, value: vb.value });
        }
      }, () => resolve(out));
    } catch (_e) { resolve(out); }
  });
}

// Raw multi-OID GET → [{oid, value}] (errors → []).
function snmpGetRawMany(session, oids) {
  return new Promise((resolve) => {
    try {
      session.get(oids, (err, vbs) => {
        if (err || !vbs) return resolve([]);
        const out = [];
        for (const vb of vbs) {
          if (!snmp.isVarbindError(vb)) out.push({ oid: vb.oid, value: vb.value });
        }
        resolve(out);
      });
    } catch (_e) { resolve([]); }
  });
}

// Execute a server-pushed fetch plan and ship the raw varbinds as an snmp_batch.
// Buffers (Counter64 / OctetString / MAC) are base64-encoded so they survive JSON.
async function runSnmpPlan(device, send, logger) {
  const session = createSnmpSession(device);
  const label = `${device.name || device.id} (${device.ip_address})`;
  const plan = device.snmp_plan || {};
  const enc = (v) => Buffer.isBuffer(v) ? { b: v.toString('base64') } : v;
  try {
    const walks = {};
    let walkCount = 0;
    for (const base of plan.walks || []) {
      const rows = await snmpWalkRaw(session, base);
      walks[base] = rows.map((r) => ({ oid: r.oid, value: enc(r.value) }));
      walkCount += rows.length;
    }
    const gets = {};
    const getOids = plan.gets || [];
    for (let i = 0; i < getOids.length; i += 16) {
      const chunk = getOids.slice(i, i + 16);
      const rows = await snmpGetRawMany(session, chunk);
      for (const r of rows) gets[r.oid] = enc(r.value);
    }
    send({ type: 'snmp_batch', device_id: device.id, ts: new Date().toISOString(), walks, gets });
    logger.info(`SNMP ${label}: shipped batch (${walkCount} walk varbinds, ${Object.keys(gets).length} scalars)`);
  } catch (e) {
    logger.error(`SNMP plan error for ${label}:`, e.message);
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
}

// ── Legacy-path helpers (agent.js:583-638) ────────────────────
// sysObjectID's enterprise arc (1.3.6.1.4.1.<enterprise>...) → vendor OID set.
function enterpriseOf(sysObjId) {
  const m = String(sysObjId || '').match(/^1\.3\.6\.1\.4\.1\.(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Raw (non-numeric) SNMP get — sysObjectID is an OID, not a number. Resolves the
// raw value or null.
function snmpGetRaw(session, oid) {
  return new Promise((resolve) => {
    session.get([oid], (err, vbs) => {
      if (err || !vbs || !vbs[0] || snmp.isVarbindError(vbs[0])) return resolve(null);
      resolve(vbs[0].value);
    });
  });
}

// Resolves { value, err }. err is a short reason string when the value could not
// be read so doSnmp can log WHY a metric was dropped instead of failing silently.
function snmpGet(session, oid) {
  return new Promise((resolve) => {
    session.get([oid], (err, varbinds) => {
      if (err) return resolve({ value: null, err: err.message || String(err) });
      const vb = varbinds && varbinds[0];
      if (!vb) return resolve({ value: null, err: 'no varbind' });
      if (snmp.isVarbindError(vb)) return resolve({ value: null, err: snmp.varbindError(vb) });
      const v = Number(vb.value);
      if (isNaN(v)) return resolve({ value: null, err: 'non-numeric value' });
      resolve({ value: v, err: null });
    });
  });
}

// Fallback for devices that don't expose CPU at hrProcessorLoad.1: walk the whole
// hrProcessorLoad table and average all instances. Resolves null if empty.
function snmpWalkAvg(session, baseOid) {
  return new Promise((resolve) => {
    const vals = [];
    let settled = false;
    const done = () => {
      if (settled) return; settled = true;
      if (!vals.length) return resolve(null);
      resolve(Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10);
    };
    try {
      session.subtree(baseOid, 20, (vbs) => {
        for (const vb of vbs || []) {
          if (snmp.isVarbindError(vb)) continue;
          const v = Number(vb.value);
          if (!isNaN(v)) vals.push(v);
        }
      }, () => done());
    } catch (_e) { done(); }
  });
}

// Legacy per-metric SNMP poll (agent.js:663-740). Emits individual snmp_result
// messages. Preserved for old-server compatibility (no plan pushed).
async function doSnmp(device, send, logger) {
  const session = createSnmpSession(device);
  const ts = new Date().toISOString();

  const label = `${device.name || device.id} (${device.ip_address})`;
  try {
    // Identify the vendor up front so CPU/mem can fall back to its MIB if the
    // standard HOST-RESOURCES OIDs are empty (e.g. HP/Aruba ProCurve switches).
    const sysObjId = await snmpGetRaw(session, SNMP_OID.sys_object_id);
    const vendor = VENDOR_SNMP[enterpriseOf(sysObjId)] || null;

    const [cpuR, memUsedR, memTotalR, uptimeR] = await Promise.all([
      snmpGet(session, SNMP_OID.cpu_pct),
      snmpGet(session, SNMP_OID.mem_used),
      snmpGet(session, SNMP_OID.mem_total),
      snmpGet(session, SNMP_OID.uptime),
    ]);

    // CPU: standard hrProcessorLoad.1 → walk the processor table → vendor MIB.
    let cpu = cpuR.value;
    let cpuOid = SNMP_OID.cpu_pct;
    if (cpu === null) cpu = await snmpWalkAvg(session, '1.3.6.1.2.1.25.3.3.1.2');
    if (cpu === null && vendor && vendor.cpu) {
      const r = await snmpGet(session, vendor.cpu);
      if (r.value !== null) { cpu = r.value; cpuOid = vendor.cpu; }
    }

    // Memory %: standard hrStorage → vendor total/free bytes.
    let memPct = null;
    let memOid = SNMP_OID.mem_used;
    if (memUsedR.value !== null && memTotalR.value !== null && memTotalR.value > 0) {
      memPct = Math.round((memUsedR.value / memTotalR.value) * 1000) / 10;
    } else if (vendor && vendor.memTotal && vendor.memFree) {
      const [tot, free] = await Promise.all([
        snmpGet(session, vendor.memTotal),
        snmpGet(session, vendor.memFree),
      ]);
      if (tot.value !== null && free.value !== null && tot.value > 0) {
        memPct = Math.round(((tot.value - free.value) / tot.value) * 1000) / 10;
        memOid = vendor.memTotal;
      }
    }

    let sent = 0;
    if (cpu !== null) {
      send({ type: 'snmp_result', device_id: device.id, ts,
             oid: cpuOid, metric_name: 'cpu_pct', value: cpu });
      sent++;
    }
    if (memPct !== null) {
      send({ type: 'snmp_result', device_id: device.id, ts,
             oid: memOid, metric_name: 'mem_pct', value: memPct });
      sent++;
    }
    if (uptimeR.value !== null) {
      send({ type: 'snmp_result', device_id: device.id, ts,
             oid: SNMP_OID.uptime, metric_name: 'uptime', value: uptimeR.value });
      sent++;
    }

    if (sent === 0) {
      // Don't fail silently — surface the most telling reason so an operator can
      // tell "wrong community/timeout" from "OIDs unsupported by this device".
      const reason = cpuR.err || uptimeR.err || 'no response';
      const warn = logger.warn || logger.info;
      warn(`SNMP ${label}: no metrics (v${device.snmp_version || '2c'}, ` +
        `community="${device.snmp_version === '3' ? 'v3' : (device.snmp_community || 'public')}") — ${reason}`);
    } else {
      logger.info(`SNMP ${label}: ${sent} metric(s)` +
        (cpu !== null ? ` cpu=${cpu}%` : '') +
        (memPct !== null ? ` mem=${memPct}%` : '') +
        (vendor ? ` [${vendor.name}]` : ''));
    }
  } catch (e) {
    logger.error(`SNMP error for ${label}:`, e.message);
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
}

module.exports = { createSnmpSession, runSnmpPlan, doSnmp, SNMP_OID, VENDOR_SNMP };
