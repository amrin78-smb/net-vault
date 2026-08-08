'use strict';
/**
 * core/transport.js — outbound WebSocket dial-back client.
 *
 * A single outbound WS to the server: sends messages (buffering when offline),
 * receives server pushes, and reconnects with exponential backoff + jitter.
 * Extracted from agent.js:72-147 preserving byte-for-byte on-wire behaviour:
 *   - the WS URL is built from the server HOST + dedicated WS port (any port on
 *     serverUrl is dropped so we never emit host:3008:3010),
 *   - heartbeats are NEVER buffered (a stale one replayed on reconnect would bump
 *     last_seen_at and mask how long the agent was actually gone),
 *   - on open: reset backoff, let the entrypoint send its connect heartbeat
 *     FIRST (via onOpen), THEN flush the offline buffer as one {type:'batch'},
 *   - the exact backoff curve (base capped at 120s, 0.8-1.2 jitter, single timer).
 */
const WebSocket = require('ws');
const tls = require('tls');

// ── TLS for wss:// ingests ───────────────────────────────────────────────────
//
// The app servers (SpanVault :3010, DDIVault :3011) terminate wss:// with a
// SELF-SIGNED certificate they generate themselves — deliberately, so an
// operator never has to obtain or deploy one (the same zero-deployment
// experience PRTG gives for its probe connections). A self-signed cert has no
// chain to validate, so `rejectUnauthorized: true` would reject every
// connection; it is set false and the certificate is instead pinned by
// SHA-256 fingerprint.
//
// Why pin rather than just encrypt: without pinning, TLS stops someone
// *reading* the WinRM and SNMP credentials off the wire but not someone
// *substituting themselves* for the server. `ddi_config` carries DECRYPTED
// WinRM passwords, so that distinction is worth the one config value.
//
// Pins are PER APP, because SpanVault and DDIVault each generate their own
// self-signed certificate — a single shared pin would verify one and reject the
// other, and both transports here are handed the same `config` object.
//   config.wsFingerprints = { span: "<sha256>", ddi: "<sha256>" }
// `config.wsFingerprint` is still honoured as a single-endpoint fallback.
//
// The pin is set at install time from the command the hub generates. It is
// deliberately NOT taken from the hub's policy response: the hub channel is
// plain HTTP, so anyone able to substitute the server could substitute the
// fingerprint alongside it and the pin would verify against the attacker. A pin
// is only worth having if it arrives by a different route than the thing it
// authenticates.
//
// No fingerprint configured => still connect (encrypted, unverified) and warn.
// Refusing would strand an agent whose operator upgraded the server first, and
// encrypted-but-unpinned is strictly better than the plain ws:// it replaces.
//
// WHERE the pin is checked matters as much as that it is checked. The obvious
// place — the 'upgrade' event — is TOO LATE: the Authorization header travels in
// the upgrade REQUEST, so by the time the response arrives the agent's Bearer
// credential has already been handed to whoever answered. Verified by test:
// an impostor endpoint read `Bearer <jwt>` in full before the pin closed the
// socket. For a legacy api_key agent that credential does not expire, so the
// leak outlives the connection it happened on.
//
// So when a pin IS configured we take over socket creation and verify the
// certificate on 'secureConnect' — after the TLS handshake, before http.request
// writes a single header byte. On mismatch the socket is destroyed and the
// request never starts.
//
// Note the callback discipline: http.ClientRequest does
// `if (newSocket) oncreate(null, newSocket)` on whatever createConnection
// RETURNS, and oncreate is once()-wrapped. Returning the socket would hand it
// over immediately — before secureConnect — and reintroduce the very leak this
// closes. Return undefined; only ever hand the socket over via `cb`.
function tlsOptionsFor(url, config, app) {
  if (!/^wss:/i.test(String(url || ''))) return {};
  const fps = (config && config.wsFingerprints) || {};
  const want = normalizeFp((app && fps[app]) || (config && config.wsFingerprint));
  // Unpinned: nothing to verify, so there is nothing to gate the request on.
  if (!want) return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: false,
    // Deliberately NO `agent` key. `agent: false` reads like "no agent" but Node
    // treats it as "build a fresh default Agent", and once ANY agent is present
    // the agent owns socket creation and `createConnection` below is never
    // called — the request goes out over ws's own TLS connect and the credential
    // leaks exactly as before. Leaving agent undefined alongside a
    // createConnection is the no-agent path, and is what ws itself relies on.
    createConnection: (connOpts, cb) => {
      const sock = tls.connect({ ...connOpts, rejectUnauthorized: false }, () => {
        let got = '';
        try {
          got = normalizeFp(sock.getPeerCertificate().fingerprint256);
        } catch (_e) {
          got = '';
        }
        if (got !== want) {
          sock.destroy();
          cb(new Error('TLS pin mismatch — refusing to send credentials'));
          return;
        }
        cb(null, sock);
      });
      sock.once('error', (e) => cb(e));
      return undefined;
    },
  };
}

function normalizeFp(v) {
  return String(v || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

function createTransport({ config, identity, buffer, onMessage, onOpen, logger, app }) {
  let ws = null;
  let reconnectTimeout = null;
  let reconnectAttempts = 0;
  let stopped = false;
  let awaitingReady = false; // deferring the dial until identity.isReady()
  let readyPollTimer = null;
  let lastAuthToken = null; // the Authorization value the LIVE socket connected with

  // Build the per-connection TLS options (no-op for a plain ws:// ingest).
  function tlsOptions(url) {
    // `app` selects this transport's own pin — without it a dual-module agent
    // would gate the span socket on the ddi pin (or none at all).
    return tlsOptionsFor(url, config, app);
  }

  // Verify the server's certificate fingerprint on the HTTP upgrade, which fires
  // BEFORE 'open', so a substituted certificate is rejected before any frame.
  //
  // This is now a SECOND line of defence, not the primary one. When a pin is
  // configured the handshake-time check in tlsOptionsFor() has already run and
  // the request was never sent. This layer still earns its place: it is what
  // logs the UNPINNED case, and it re-checks the certificate the connection
  // actually ended up on. Do NOT treat it as sufficient on its own — it cannot
  // protect the Authorization header, which is sent in the upgrade REQUEST and
  // is therefore already disclosed by the time this fires.
  function armFingerprintCheck(sock, url) {
    if (!/^wss:/i.test(String(url || ''))) return;
    const fps = (config && config.wsFingerprints) || {};
    const want = normalizeFp((app && fps[app]) || (config && config.wsFingerprint));
    sock.on('upgrade', (res) => {
      let got = '';
      try {
        const cert = res.socket && res.socket.getPeerCertificate && res.socket.getPeerCertificate();
        got = normalizeFp(cert && cert.fingerprint256);
      } catch (e) {
        logErr('TLS: could not read server certificate:', e.message);
      }
      if (!want) {
        // Encrypted but unauthenticated — say so plainly rather than implying
        // the connection is fully protected.
        log('TLS: connected encrypted but UNPINNED (set wsFingerprint in config.json to verify the server).');
        return;
      }
      if (!got) {
        logErr('TLS: no server certificate available to verify against the configured pin — closing.');
        try { sock.close(4003, 'TLS pin unverifiable'); } catch (_e) { /* already closing */ }
        return;
      }
      if (got !== want) {
        logErr(`TLS: server certificate fingerprint MISMATCH — closing. expected ${want.slice(0, 16)}… got ${got.slice(0, 16)}…`);
        try { sock.close(4004, 'TLS pin mismatch'); } catch (_e) { /* already closing */ }
        return;
      }
      log('TLS: server certificate verified against configured pin.');
    });
  }

  function log(...a) {
    if (logger && logger.info) logger.info(...a);
  }
  function logErr(...a) {
    if (logger && logger.error) logger.error(...a);
  }

  function buildUrl() {
    // Strip any port on serverUrl (which usually points at the frontend, e.g.
    // http://host:3008) so we never produce host:3008:3010. Fall back to the raw
    // serverUrl if it isn't a parseable URL (a bare host).
    let host = config.serverUrl;
    try {
      host = new URL(config.serverUrl).hostname;
    } catch (_e) {
      /* serverUrl may be bare */
    }
    const scheme = /^https/i.test(config.serverUrl) ? 'wss' : 'ws';
    const port = config.wsPort || 3010;
    return `${scheme}://${host}:${port}/`;
  }

  // WHERE to dial. JWT-mode: the hub-provided span ingest URL (identity.getIngest()).
  // apiKey-mode (or JWT-mode with no ingest advertised): config.serverUrl + wsPort,
  // exactly as Phase 1 — buildUrl()'s port-stripping is preserved for that case.
  function currentUrl() {
    const ingest = typeof identity.getIngest === 'function' ? identity.getIngest() : null;
    if (ingest) return ingest;
    return buildUrl();
  }

  // The Authorization header value the transport WOULD present right now. Used to
  // detect an identity rotation (refresh/revoke) so we only reconnect when the
  // presented credential actually changed — the Bearer header is fixed at connect.
  function authTokenOf() {
    try {
      return (identity.getAuthHeader() || {}).Authorization || null;
    } catch (_e) {
      return null;
    }
  }

  function isOpen() {
    return !!(ws && ws.readyState === WebSocket.OPEN);
  }

  function send(msg) {
    if (isOpen()) {
      // Defensive: a non-serializable value (e.g. a BigInt in a result) or a mid-flight
      // socket error would otherwise throw synchronously → the entrypoint's
      // uncaughtException → process.exit(1). Catch it: drop a heartbeat (stale-worthless),
      // re-buffer a real result so it retries on the next connection. Success path unchanged.
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        logErr('send failed:', e && e.message);
        if (msg && msg.type === 'heartbeat') return;
        buffer.push(msg);
      }
    } else {
      // Heartbeats are worthless once stale — only buffer real results.
      if (msg && msg.type === 'heartbeat') return;
      buffer.push(msg);
    }
  }

  function start() {
    if (stopped) return;
    // GATE (JWT-mode): don't dial until the identity is ready. In apiKey-mode
    // isReady() is true immediately (or identity has no isReady() — e.g. a bare
    // test stub — in which case we treat it as ready), so this is a no-op there and
    // the Phase 1 "dial straight away" behaviour is preserved.
    if (typeof identity.isReady === 'function' && !identity.isReady()) {
      if (!awaitingReady) {
        awaitingReady = true;
        log('Identity not ready — deferring connection until enrolled/loaded');
        armReadyPoll();
      }
      return;
    }
    awaitingReady = false;
    stopReadyPoll();
    connect();
  }

  function connect() {
    if (stopped) return;
    const url = currentUrl();
    log('Connecting to', url);
    lastAuthToken = authTokenOf();
    ws = new WebSocket(url, { headers: identity.getAuthHeader(), ...tlsOptions(url) });
    armFingerprintCheck(ws, url);

    ws.on('open', () => {
      log('Connected to server');
      reconnectAttempts = 0; // reset backoff on a successful connect
      // The entrypoint sends the connect heartbeat synchronously here. ORDER
      // MATTERS: heartbeat first, THEN the buffered batch flush.
      try {
        if (onOpen) onOpen();
      } catch (e) {
        logErr('onOpen error:', e.message);
      }
      if (buffer.depth() > 0) {
        const results = buffer.all();
        // Defensive: a non-serializable buffered value or a socket error mid-flush would
        // otherwise throw synchronously out of this 'open' handler → uncaughtException →
        // process.exit(1). Catch it and KEEP the buffer (do not clear) so the results are
        // retried on the next open rather than lost. Success path unchanged.
        try {
          ws.send(JSON.stringify({ type: 'batch', results }));
          log(`Flushed ${results.length} buffered result(s)`);
          buffer.clear();
        } catch (e) {
          logErr('Buffer flush failed — keeping buffered results for retry:', e && e.message);
        }
      }
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        onMessage(msg);
      } catch (e) {
        logErr('Message parse error:', e.message);
      }
    });

    ws.on('close', () => {
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      logErr('WS error:', err.message);
      scheduleReconnect();
    });
  }

  // Exponential backoff with jitter, capped at 2 minutes, so a fleet of agents
  // doesn't reconnect in lockstep and hammer the server after an outage.
  function scheduleReconnect() {
    if (stopped) return;
    reconnectAttempts++;
    const base = Math.min(120000, 10000 * Math.pow(1.5, reconnectAttempts - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(start, delay);
    log(
      `Disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`
    );
  }

  // ── Identity-readiness gate (JWT-mode) ─────────────────────────────────────────
  // Light poll as a backstop to the onChange event, so even a store that doesn't
  // emit (or a race) still connects within a couple of seconds once ready. Unref'd
  // so it never keeps the process alive on its own.
  function armReadyPoll() {
    if (readyPollTimer) return;
    readyPollTimer = setInterval(() => {
      if (stopped) return;
      if (typeof identity.isReady === 'function' && identity.isReady()) start();
    }, 2000);
    if (readyPollTimer.unref) readyPollTimer.unref();
  }
  function stopReadyPoll() {
    if (readyPollTimer) {
      clearInterval(readyPollTimer);
      readyPollTimer = null;
    }
  }

  // Drop the current socket and dial again PROMPTLY (no backoff) — used when the
  // identity rotated so the new Bearer token (+ possibly a new ingest URL) takes
  // effect. We detach the old socket's handlers first so its imminent 'close' does
  // NOT also schedule a backoff reconnect racing this one.
  function reconnect() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    reconnectAttempts = 0;
    try {
      if (ws) {
        ws.removeAllListeners('close');
        ws.removeAllListeners('error');
        ws.close();
      }
    } catch (_e) {
      /* ignore */
    }
    ws = null;
    start();
  }

  // Fires when the shared identity store changes (enroll / refresh / revoke). Headers
  // are fixed at the WS handshake, so a credential change means: connect now if we
  // were deferring, or reconnect if the presented token actually changed.
  function onIdentityChange() {
    if (stopped) return;
    if (awaitingReady) {
      if (typeof identity.isReady === 'function' && identity.isReady()) start();
      return;
    }
    if (authTokenOf() !== lastAuthToken) {
      log('Identity changed — reconnecting to present the new credential');
      reconnect();
    }
  }
  if (typeof identity.onChange === 'function') identity.onChange(onIdentityChange);

  function stop() {
    stopped = true;
    awaitingReady = false;
    stopReadyPoll();
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    try {
      if (ws) ws.close();
    } catch (_e) {
      /* ignore */
    }
  }

  return { start, send, isOpen, stop };
}

module.exports = createTransport;
