'use strict';
/**
 * modules/span/checks.js — agentless service checks (HTTP/TCP/SSL/DNS).
 *
 * Extracted verbatim from the legacy SpanVault agent (agent.js:238-399),
 * preserving byte-for-byte on-wire behaviour. runAndReport() dispatches on
 * check.type and ships EXACTLY:
 *   { type:'service_result', check_id, status, response_ms, detail }
 * Constants preserved: timeouts default 10000ms, SSL warn default 14 days,
 * HTTP body cap 1MB (1048576), SSL default port 443.
 */
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');

// Run one check and ship its service_result (agent.js:238-253).
async function runAndReport(check, send) {
  const params = check.params || {};
  let result;
  switch (check.type) {
    case 'http': result = await checkHttp(check.target, params); break;
    case 'tcp':  result = await checkTcp(check.target, params); break;
    case 'ssl':  result = await checkSsl(check.target, params); break;
    case 'dns':  result = await checkDns(check.target, params); break;
    default:
      result = { status: 'unknown', response_ms: null, detail: `Unknown type: ${check.type}` };
  }
  send({
    type: 'service_result', check_id: check.id,
    status: result.status, response_ms: result.response_ms, detail: result.detail,
  });
}

// Parse "host:port" / "host" / a URL into { host, port } using fallbackPort when
// the target carries no port (agent.js:257-275).
function splitHostPort(target, fallbackPort) {
  let host = String(target || '').trim();
  let port = fallbackPort;
  try {
    if (/:\/\//.test(host)) {
      const u = new URL(host);
      host = u.hostname;
      if (u.port) port = parseInt(u.port, 10);
    } else {
      // Strip a trailing :port (but leave bare IPv6 alone — not expected here).
      const idx = host.lastIndexOf(':');
      if (idx > -1 && /^\d+$/.test(host.slice(idx + 1))) {
        port = parseInt(host.slice(idx + 1), 10);
        host = host.slice(0, idx);
      }
    }
  } catch (_e) { /* fall through with defaults */ }
  return { host, port };
}

// http: GET the target; up = status in expect range AND (no keyword OR body
// contains it). Never throws (agent.js:279-326).
function checkHttp(target, params) {
  return new Promise((resolve) => {
    const timeoutMs = parseInt(params.timeout_ms, 10) || 10000;
    let url = String(target || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    const lib = /^https/i.test(url) ? https : http;
    const start = Date.now();
    let done = false;
    const finish = (status, detail) => {
      if (done) return; done = true;
      resolve({ status, response_ms: Date.now() - start, detail });
    };
    let req;
    try {
      req = lib.get(url, (res) => {
        const code = res.statusCode;
        const wantKeyword = params.keyword ? String(params.keyword) : null;
        // Status check
        let okStatus;
        if (Array.isArray(params.expect_status)) {
          okStatus = params.expect_status.indexOf(code) !== -1;
        } else if (params.expect_status != null) {
          okStatus = code === parseInt(params.expect_status, 10);
        } else {
          okStatus = code >= 200 && code <= 399;
        }
        if (!okStatus) { res.resume(); return finish('down', `HTTP ${code}`); }
        if (!wantKeyword) { res.resume(); return finish('up', `HTTP ${code}`); }
        // Need the body to check the keyword.
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 1048576) { body = body.slice(0, 1048576); } // cap at 1MB
        });
        res.on('end', () => {
          if (body.indexOf(wantKeyword) !== -1) finish('up', `HTTP ${code}`);
          else finish('down', `HTTP ${code} (keyword missing)`);
        });
        res.on('error', (e) => finish('down', e.message));
      });
    } catch (e) {
      return finish('down', e.message);
    }
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_e) {} finish('down', 'Timeout'); });
    req.on('error', (e) => finish('down', e.message));
  });
}

// tcp: connect to host:port within the timeout. up on connect, down otherwise
// (agent.js:329-349).
function checkTcp(target, params) {
  return new Promise((resolve) => {
    const timeoutMs = parseInt(params.timeout_ms, 10) || 10000;
    const { host, port } = splitHostPort(target, parseInt(params.port, 10) || null);
    const start = Date.now();
    let done = false;
    const finish = (status, detail) => {
      if (done) return; done = true;
      resolve({ status, response_ms: status === 'up' ? Date.now() - start : null, detail });
    };
    if (!port) return finish('down', 'No port specified');
    let socket;
    try {
      socket = net.connect({ host, port });
    } catch (e) { return finish('down', e.message); }
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => { try { socket.destroy(); } catch (_e) {} finish('up', `Connected ${host}:${port}`); });
    socket.on('timeout', () => { try { socket.destroy(); } catch (_e) {} finish('down', 'Timeout'); });
    socket.on('error', (e) => { try { socket.destroy(); } catch (_e) {} finish('down', e.message); });
  });
}

// ssl: TLS handshake; inspect the peer cert's valid_to. warning if it expires
// within ssl_warn_days, else up. down on any handshake/connection error
// (agent.js:353-380).
function checkSsl(target, params) {
  return new Promise((resolve) => {
    const timeoutMs = parseInt(params.timeout_ms, 10) || 10000;
    const warnDays = parseInt(params.ssl_warn_days, 10) || 14;
    const { host, port } = splitHostPort(target, parseInt(params.port, 10) || 443);
    const start = Date.now();
    let done = false;
    const finish = (status, detail) => {
      if (done) return; done = true;
      resolve({ status, response_ms: status === 'down' ? null : Date.now() - start, detail });
    };
    let socket;
    try {
      socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate();
        try { socket.destroy(); } catch (_e) {}
        if (!cert || !cert.valid_to) return finish('down', 'No certificate');
        const validTo = new Date(cert.valid_to).getTime();
        if (isNaN(validTo)) return finish('down', 'Invalid cert date');
        const daysLeft = Math.floor((validTo - Date.now()) / 86400000);
        if (daysLeft <= warnDays) finish('warning', `Cert expires in ${daysLeft} days`);
        else finish('up', `Cert expires in ${daysLeft} days`);
      });
    } catch (e) { return finish('down', e.message); }
    socket.setTimeout(timeoutMs, () => { try { socket.destroy(); } catch (_e) {} finish('down', 'Timeout'); });
    socket.on('error', (e) => { try { socket.destroy(); } catch (_e) {} finish('down', e.message); });
  });
}

// dns: resolve the host. up if it returns >=1 record, down on error/empty
// (agent.js:383-398).
function checkDns(target, params) {
  return new Promise((resolve) => {
    const { host } = splitHostPort(target, null);
    const start = Date.now();
    let done = false;
    const finish = (status, detail) => {
      if (done) return; done = true;
      resolve({ status, response_ms: status === 'up' ? Date.now() - start : null, detail });
    };
    if (!host) return finish('down', 'No host');
    dns.resolve(host, (err, records) => {
      if (err) return finish('down', err.message);
      if (records && records.length) finish('up', `${records.length} record(s)`);
      else finish('down', 'No records');
    });
  });
}

module.exports = { runAndReport };
