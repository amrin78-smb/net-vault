'use strict';
/**
 * End-to-end integration test: the REAL agent (child process) against a fake
 * ws-server that mimics SpanVault's server surface. Proves the extracted agent
 * still speaks the wire protocol: Bearer auth on connect, the heartbeat shape,
 * and a ping_result driven by a pushed `config` — with NO real SNMP device.
 *
 * `node test/integration.test.js` — exits non-zero on failure.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const AGENT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(AGENT_DIR, 'config.json');
const BUFFER_PATH = path.join(AGENT_DIR, 'buffer.json');
const API_KEY = 'test-integration-key';

let child = null;
let wss = null;
const cleanup = () => {
  try { if (child) child.kill(); } catch (_e) {}
  try { if (wss) wss.close(); } catch (_e) {}
  for (const p of [CONFIG_PATH, BUFFER_PATH]) { try { fs.unlinkSync(p); } catch (_e) {} }
};
const fail = (m) => { console.error('  FAIL', m); cleanup(); process.exit(1); };

const received = [];
let authOk = false;

wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
  const port = wss.address().port;

  // Write a real config.json the agent will read on boot (cleaned up after).
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    serverUrl: `http://127.0.0.1:${port}`, apiKey: API_KEY, wsPort: port,
  }));

  wss.on('connection', (ws, req) => {
    authOk = req.headers.authorization === `Bearer ${API_KEY}`;
    // Mimic the server: push a config with ONE ping-only device @ loopback,
    // fast interval so the ping fires quickly. snmp_enabled:false → ping only.
    ws.send(JSON.stringify({
      type: 'config',
      devices: [{ id: 1, name: 'loopback', ip_address: '127.0.0.1', snmp_enabled: false, poll_interval_seconds: 1 }],
      settings: {}, service_checks: [], agent_sha: 'deadbeef', agent_version: '1.4.0',
    }));
    ws.on('message', (raw) => { try { received.push(JSON.parse(raw)); } catch (_e) {} });
  });

  child = spawn(process.execPath, ['nocvault-agent.js'], { cwd: AGENT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  let cerr = '';
  child.stderr.on('data', (d) => { cerr += d; });
  child.on('exit', (code) => { if (code && code !== 0 && received.length === 0) fail(`agent exited early (code ${code})\n${cerr}`); });

  // Give it up to 6s to connect, heartbeat, and complete one ping cycle.
  setTimeout(() => {
    let passed = 0;
    const okc = (n) => { console.log('  PASS', n); passed++; };

    assert.ok(authOk, 'agent connected with Authorization: Bearer <apiKey>');
    okc('Bearer auth on connect');

    const hb = received.find((m) => m.type === 'heartbeat');
    if (!hb) return fail('no heartbeat received');
    assert.deepStrictEqual(
      Object.keys(hb).sort(),
      ['health', 'hostname', 'module_status', 'type', 'version'].sort(),
      'heartbeat top-level keys = legacy 4 + additive module_status'
    );
    assert.deepStrictEqual(
      Object.keys(hb.health),
      ['cpu_pct', 'mem_pct', 'disk_pct', 'host_uptime_s', 'agent_uptime_s', 'device_count', 'buffer_depth'],
      'heartbeat.health has the 7 legacy fields'
    );
    // The first heartbeat is the connect-time one (sent on 'open', BEFORE the
    // server's config arrives) — device_count is legitimately 0 here, exactly as
    // the legacy agent behaves. Config application is proven by ping_result below.
    assert.strictEqual(typeof hb.health.device_count, 'number', 'device_count is numeric');
    assert.strictEqual(hb.module_status.span, 'ok', 'module_status.span = ok');
    okc('heartbeat shape (health 7 fields + module_status)');

    const pr = received.find((m) => m.type === 'ping_result');
    if (!pr) return fail(`no ping_result received (got: ${received.map((m) => m.type).join(',') || 'nothing'})`);
    assert.deepStrictEqual(
      Object.keys(pr).sort(),
      ['device_id', 'packet_loss_pct', 'response_ms', 'status', 'ts', 'type'].sort(),
      'ping_result has the exact legacy fields'
    );
    assert.strictEqual(pr.device_id, 1, 'ping_result.device_id = pushed device');
    assert.ok(['up', 'warning', 'down'].includes(pr.status), 'ping_result.status is a valid state');
    okc('ping_result shape (from a pushed config, real loopback ping)');

    console.log(`\n${passed} integration assertions passed.`);
    cleanup();
    process.exit(0);
  }, 6000);
});

process.on('uncaughtException', (e) => fail('uncaught: ' + e.message));
setTimeout(() => fail('overall timeout'), 12000).unref();
