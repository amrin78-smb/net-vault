'use strict';
/**
 * core/identity-store.js — the ONE shared hub-identity store (NocVault Agents, Phase 3).
 *
 * Both core/hub.js (which enrolls/heartbeats/refreshes) and core/identity.js (which
 * the span transport asks for its Bearer header) consult THIS single store, so the
 * span data path can present the hub-issued JWT and pick up a refreshed/rotated token
 * without either module reaching into the other. Before Phase 3 the JWT lived only in
 * a closure-local `let identity` inside hub.js (plus its own file I/O) and the span
 * transport could never see it.
 *
 * It persists to agent/hub-identity.json (the same file hub.js used) and now stores,
 * alongside the hub identity, the span **ingest** WS URL the hub handed back at enroll
 * (modules[].ingest) so the transport knows WHERE to dial in JWT-mode.
 *
 *   Stored/exposed shape: { agent_id, jwt, expires_at, ingest }
 *
 * API:
 *   load()          read hub-identity.json into memory; returns the identity or null
 *   get()           the in-memory identity ({...}|null) — always live, no I/O
 *   set(obj)        persist ATOMICALLY (tmp + rename) + update memory + emitChange()
 *   reject()        move the file aside to .rejected (revoked), clear memory, emit
 *   onChange(cb)    subscribe to identity changes; returns an unsubscribe fn
 *   emitChange()    notify subscribers (called by set/reject)
 *
 * The atomic write (tmp-then-rename) moved here out of hub.js:183-201 unchanged: a
 * crash mid-write must never corrupt hub-identity.json. identityPath is overridable
 * for tests.
 */
const fs = require('fs');
const path = require('path');

// Persist next to the agent (agent/hub-identity.json). The entrypoint lives one
// level up from core/, matching config.json's location.
const DEFAULT_IDENTITY_PATH = path.join(__dirname, '..', 'hub-identity.json');

function createIdentityStore(opts) {
  const options = opts || {};
  const identityPath = options.identityPath || DEFAULT_IDENTITY_PATH;
  const logger = options.logger;

  let identity = null; // { agent_id, jwt, expires_at, ingest } | null
  const listeners = [];

  function logErr(...a) {
    if (logger && logger.error) logger.error('[identity-store]', ...a);
  }

  // Normalise a raw object into the stored shape, preserving a previously-known
  // ingest URL when a caller (e.g. a token refresh returning only { jwt, expires_at })
  // doesn't supply one.
  function normalize(obj) {
    return {
      agent_id: obj.agent_id,
      jwt: obj.jwt,
      expires_at: obj.expires_at,
      ingest: obj.ingest != null ? obj.ingest : (identity && identity.ingest) || null,
    };
  }

  function load() {
    try {
      if (fs.existsSync(identityPath)) {
        const parsed = JSON.parse(fs.readFileSync(identityPath, 'utf8').replace(/^\uFEFF/, ''));
        if (parsed && parsed.agent_id && parsed.jwt) {
          identity = {
            agent_id: parsed.agent_id,
            jwt: parsed.jwt,
            expires_at: parsed.expires_at,
            ingest: parsed.ingest != null ? parsed.ingest : null,
          };
          return identity;
        }
      }
    } catch (e) {
      logErr('could not read stored identity:', e.message);
    }
    return null;
  }

  function get() {
    return identity;
  }

  function set(obj) {
    if (!obj || !obj.agent_id || !obj.jwt) return false;
    const next = normalize(obj);
    // Atomic write: write a sibling .tmp then rename over the target (atomic on the
    // same volume) so a crash mid-write cannot corrupt hub-identity.json.
    const tmpPath = identityPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2));
      fs.renameSync(tmpPath, identityPath);
    } catch (e) {
      logErr('could not persist identity:', e.message);
      try {
        fs.unlinkSync(tmpPath);
      } catch (_e) {
        /* best-effort cleanup of the temp file */
      }
      return false;
    }
    identity = next;
    emitChange();
    return true;
  }

  // Move the dead identity aside so a RESTART with a fresh enrollToken can re-enroll
  // instead of reloading a revoked JWT forever. Clears memory + notifies listeners
  // (so the JWT-mode transport drops the socket for the now-credential-less agent).
  function reject() {
    try {
      if (fs.existsSync(identityPath)) {
        const rejectedPath = identityPath + '.rejected';
        try {
          fs.renameSync(identityPath, rejectedPath);
        } catch (_e) {
          // Rename failed (e.g. a stale .rejected in the way) — fall back to delete.
          fs.unlinkSync(identityPath);
        }
      }
    } catch (e) {
      logErr('could not clear rejected identity file:', e.message);
    }
    identity = null;
    emitChange();
  }

  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function emitChange() {
    // Snapshot so a listener that (un)subscribes during dispatch can't corrupt it.
    for (const cb of listeners.slice()) {
      try {
        cb(identity);
      } catch (e) {
        logErr('onChange listener error:', e.message);
      }
    }
  }

  return {
    load,
    get,
    set,
    reject,
    onChange,
    emitChange,
    // Exposed for tests/introspection.
    _path: () => identityPath,
  };
}

module.exports = createIdentityStore;
