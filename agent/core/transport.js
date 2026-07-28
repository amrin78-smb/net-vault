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
    const url = buildUrl();
    log('Connecting to', url);
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
    reconnectAttempts++;
    const base = Math.min(120000, 10000 * Math.pow(1.5, reconnectAttempts - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(start, delay);
    log(
      `Disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`
    );
  }

  function stop() {
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
