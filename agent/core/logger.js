'use strict';
/**
 * core/logger.js — console logger + in-memory ring buffer.
 *
 * Prints "[prefix] ..." lines to the console (so NSSM captures them in the
 * service stdout/err log) AND keeps the last LOG_RING_MAX lines in memory so the
 * server can pull a live tail (get_logs) without filesystem access to the remote
 * host — matching the legacy agent's LOG_RING behaviour (agent.js:41-51,123),
 * whose get_logs replied with LOG_RING.slice(-200).
 *
 * Ring lines are formatted "<ISO ts> <LEVEL> [prefix] <text>", where non-string
 * args are JSON-stringified (falling back to String() if that throws), matching
 * the legacy ringPush() shaping.
 */
const LOG_RING_MAX = 300;

function createLogger(prefix) {
  const LOG_RING = [];

  function fmt(args) {
    return args
      .map((a) =>
        typeof a === 'string'
          ? a
          : (() => {
              try {
                return JSON.stringify(a);
              } catch (_e) {
                return String(a);
              }
            })()
      )
      .join(' ');
  }

  function ringPush(level, args) {
    const text = fmt(args);
    LOG_RING.push(`${new Date().toISOString()} ${level} [${prefix}] ${text}`);
    if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
  }

  return {
    info(...a) {
      ringPush('INFO', a);
      console.log(`[${prefix}]`, ...a);
    },
    error(...a) {
      ringPush('ERROR', a);
      console.error(`[${prefix}]`, ...a);
    },
    // Return the last n ring lines as an array of strings (default 200, matching
    // the legacy get_logs reply). n is clamped to the ring size.
    tail(n) {
      const count = n == null ? 200 : n;
      return LOG_RING.slice(-count);
    },
  };
}

module.exports = createLogger;
