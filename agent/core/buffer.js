'use strict';
/**
 * core/buffer.js — disk-backed offline buffer.
 *
 * Holds poll results while the server is unreachable, capped at `max`, persisted
 * to <dir>/buffer.json so a service restart mid-outage doesn't lose queued
 * results. Flushed on reconnect by the transport as a single {type:'batch',...}.
 * Extracted from agent.js:27-71 (loadBuffer/saveBuffer/the buffer array) with the
 * same file name, same JSON-array format, same slice(-max) cap semantics, and the
 * same "persist errors are logged, never thrown" rule.
 */
const fs = require('fs');
const path = require('path');

function createBuffer({ dir, max = 500, logger }) {
  const bufferPath = path.join(dir, 'buffer.json');

  // Load on init: a JSON array, or [] on ANY error (missing/corrupt/unreadable) —
  // matching loadBuffer()'s try/catch->[] (agent.js:64-67).
  let buffer;
  try {
    buffer = JSON.parse(fs.readFileSync(bufferPath, 'utf8'));
    if (!Array.isArray(buffer)) buffer = [];
  } catch (_e) {
    buffer = [];
  }

  function persist() {
    try {
      fs.writeFileSync(bufferPath, JSON.stringify(buffer.slice(-max)));
    } catch (e) {
      if (logger && logger.error) logger.error('Buffer save error:', e.message);
    }
  }

  return {
    // Append a message, keep only the last `max`, then persist.
    push(msg) {
      buffer.push(msg);
      if (buffer.length > max) buffer = buffer.slice(-max);
      persist();
    },
    // The current queued messages (the array the transport flushes as a batch).
    all() {
      return buffer;
    },
    // Empty the buffer and persist the empty state.
    clear() {
      buffer = [];
      persist();
    },
    depth() {
      return buffer.length;
    },
  };
}

module.exports = createBuffer;
