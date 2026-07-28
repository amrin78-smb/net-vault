'use strict';
/**
 * core/health.js — agent-host health sampler.
 *
 * Samples the AGENT BOX's own health (CPU/mem/disk/uptime) plus the two live
 * counts the runtime injects (device_count, buffer_depth), shipped on each
 * heartbeat so operators can spot a struggling collector early — not just the
 * devices it polls.
 *
 * build() returns EXACTLY the 7 fields the legacy agent's buildHealth() produced
 * (agent.js:185-196), byte-identical in shape and rounding, so the SpanVault
 * server sees an unchanged health object:
 *   { cpu_pct, mem_pct, disk_pct, host_uptime_s, agent_uptime_s,
 *     device_count, buffer_depth }
 *
 * Ports (agent.js:152-196):
 *  - cpuPct(): stateful idle/total delta of os.cpus(), rounded to 0.1; null until
 *    a second sample exists (dTotal<=0) — prevCpu state lives per-instance here.
 *  - sampleDisk(): fs.statfs(__dirname) every 60s -> lastDiskPct; guarded so it
 *    no-ops (leaving disk_pct null) on Node < 18.15 where fs.statfs is absent.
 *  - mem/host_uptime/agent_uptime: os.freemem/totalmem, os.uptime, process.uptime.
 *
 * The 60s disk sampler starts when the module is created (matching the legacy
 * module-load-time setInterval + immediate first sample).
 */
const os = require('os');
const fs = require('fs');

function createHealth({ getDeviceCount, getBufferDepth } = {}) {
  // Prime the CPU delta with a first sample so the second call can produce a
  // real percentage (the first build() still returns null, same as the legacy
  // agent whose prevCpu was primed at module load — agent.js:152).
  let prevCpu = cpuSample();
  let lastDiskPct = null;

  function cpuSample() {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus() || []) {
      for (const k of Object.keys(c.times)) total += c.times[k];
      idle += c.times.idle;
    }
    return { idle, total };
  }

  function cpuPct() {
    const cur = cpuSample();
    const dIdle = cur.idle - prevCpu.idle;
    const dTotal = cur.total - prevCpu.total;
    prevCpu = cur;
    if (dTotal <= 0) return null;
    return Math.round((1 - dIdle / dTotal) * 1000) / 10;
  }

  function sampleDisk() {
    try {
      if (typeof fs.statfs !== 'function') return; // Node < 18.15 — leave disk_pct null
      fs.statfs(__dirname, (err, st) => {
        if (err || !st || !st.blocks) return;
        const total = st.blocks * st.bsize;
        const free = st.bfree * st.bsize;
        lastDiskPct = total ? Math.round(((total - free) / total) * 1000) / 10 : null;
      });
    } catch (_e) {
      /* ignore */
    }
  }

  // Start the 60s disk sampler + take an immediate first sample (agent.js:182-183).
  const diskTimer = setInterval(sampleDisk, 60000);
  if (diskTimer.unref) diskTimer.unref(); // don't keep the process alive on this timer alone
  sampleDisk();

  return {
    build() {
      const totalMem = os.totalmem();
      return {
        cpu_pct: cpuPct(),
        mem_pct: totalMem ? Math.round((1 - os.freemem() / totalMem) * 1000) / 10 : null,
        disk_pct: lastDiskPct,
        host_uptime_s: Math.round(os.uptime()),
        agent_uptime_s: Math.round(process.uptime()),
        device_count: typeof getDeviceCount === 'function' ? getDeviceCount() : 0,
        buffer_depth: typeof getBufferDepth === 'function' ? getBufferDepth() : 0,
      };
    },
  };
}

module.exports = createHealth;
