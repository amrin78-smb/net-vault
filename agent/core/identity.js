'use strict';
/**
 * core/identity.js — agent auth identity.
 *
 * Phase 1: a static apiKey presented as a Bearer token, exactly as the legacy
 * SpanVault agent did (Authorization: Bearer <apiKey> on the WS upgrade request).
 *
 * The interface (getAuthHeader) is deliberately the seam Phase 2 slots a
 * hub-issued, rotatable identity into — the transport only ever asks this module
 * for a header object and never reaches for config.apiKey directly, so swapping
 * the implementation (and, later, an onIdentityRotate hook) touches nothing else.
 */
function createIdentity(config) {
  return {
    // Returns the header object handed to the ws upgrade request.
    getAuthHeader() {
      return { Authorization: 'Bearer ' + config.apiKey };
    },
  };
}

module.exports = createIdentity;
