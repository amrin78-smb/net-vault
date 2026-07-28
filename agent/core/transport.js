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

function createTransport({ config, identity, buffer, onMessage, onOpen, logger }) {
  let ws = null;
  let reconnectTimeout = null;
  let reconnectAttempts = 0;
  let stopped = false;
  let awaitingReady = false; // deferring the dial until identity.isReady()
  let readyPollTimer = null;
  let lastAuthToken = null; // the Authorization value the LIVE socket connected with

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
      ws.send(JSON.stringify(msg));
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
    ws = new WebSocket(url, { headers: identity.getAuthHeader() });

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
        ws.send(JSON.stringify({ type: 'batch', results }));
        log(`Flushed ${results.length} buffered result(s)`);
        buffer.clear();
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
