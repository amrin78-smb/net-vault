'use strict';
/**
 * core/identity.js — agent auth identity (the span data-path auth seam).
 *
 * TWO MODES, backward compatible (NocVault Agents, Phase 3):
 *
 *   - apiKey-mode (legacy): no shared identity store has a valid hub identity, so
 *     getAuthHeader() returns `Bearer <config.apiKey>` — byte-for-byte as Phase 1.
 *   - JWT-mode: the shared identity store (core/identity-store.js, fed by core/hub.js
 *     on enroll/refresh) holds a valid, unexpired hub-issued JWT; getAuthHeader()
 *     returns `Bearer <that jwt>`.
 *
 * The transport ONLY ever asks this module for a header (getAuthHeader), whether it
 * is ready (isReady), where to dial in JWT-mode (getIngest), and to be told when the
 * identity rotated (onChange) — so it never reaches into config.apiKey or the store
 * directly. The store is optional: with no store (or an empty one) this behaves
 * exactly as the Phase 1 apiKey identity.
 */
function createIdentity(config, store) {
  const cfg = config || {};

  // The store's identity, but only if it's a usable, unexpired hub JWT. An identity
  // with no expires_at is treated as valid (never seen in practice — the hub always
  // sets one — but we must not fail closed on a malformed/missing expiry field).
  function validHubIdentity() {
    if (!store || typeof store.get !== 'function') return null;
    const id = store.get();
    if (!id || !id.jwt) return null;
    if (id.expires_at) {
      const t = Date.parse(id.expires_at);
      if (!isNaN(t) && Date.now() >= t) return null; // expired hub identity
    }
    return id;
  }

  return {
    // Header handed to the ws upgrade request. JWT-first: present the hub identity
    // when the store has a valid one, else fall back to the legacy apiKey.
    getAuthHeader() {
      const id = validHubIdentity();
      if (id) return { Authorization: 'Bearer ' + id.jwt };
      return { Authorization: 'Bearer ' + cfg.apiKey };
    },

    // The transport gates its dial on this: ready when a legacy apiKey is configured
    // (immediate, as Phase 1) OR a valid hub identity has been loaded/enrolled.
    isReady() {
      if (cfg.apiKey) return true;
      return !!validHubIdentity();
    },

    // JWT-mode dial target: the hub-provided span ingest WS URL, when we have a
    // valid hub identity carrying one. null → the transport falls back to
    // config.serverUrl + wsPort (its Phase 1 behaviour).
    getIngest() {
      const id = validHubIdentity();
      return id && id.ingest ? id.ingest : null;
    },

    // Let the transport react to a rotated/refreshed/revoked identity (headers are
    // fixed at connect, so rotation means reconnect). No store → no-op unsubscribe.
    onChange(cb) {
      if (store && typeof store.onChange === 'function') return store.onChange(cb);
      return () => {};
    },
  };
}

module.exports = createIdentity;
