'use strict';
/**
 * core/runtime.js — server-push message router.
 *
 * transport.onMessage hands every parsed server message to dispatch(), which
 * handles the core-level control messages (restart, get_logs, signed self-update)
 * and then forwards EVERY message on to each loaded module's onMessage — so the
 * span module still sees config/discover exactly as the legacy agent did
 * (agent.js:113-126), and future modules receive their own pushes the same way.
 */
function createRuntime({ config, transport, logger, updater, modules }) {
  function log(...a) {
    if (logger && logger.info) logger.info(...a);
  }

  function dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'restart') {
      log('Restart requested by server — exiting (service will restart)');
      process.exit(0);
      return;
    }

    if (msg.type === 'get_logs') {
      transport.send({ type: 'logs', lines: logger.tail(200) });
      return;
    }

    if (msg.type === 'config') {
      // Signed multi-file self-update: the server advertises a signed agent
      // bundle manifest; the updater verifies signature + hashes before applying.
      if (msg.agent_bundle && updater && updater.consider) {
        updater.consider(msg.agent_bundle);
      }
      // NOTE: we deliberately ignore the legacy single-file msg.agent_sha. The
      // unified agent is a whole agent/ directory (core/ + modules/ + entrypoint),
      // so it cannot safely overwrite itself from a single-file agent.js
      // fingerprint the way the legacy agent did — only the signed-bundle path
      // (agent_bundle) can update a multi-file agent.
    }

    // Forward every message (including config/discover) to each module.
    for (const m of modules) {
      if (m && m.onMessage) {
        try {
          m.onMessage(msg);
        } catch (e) {
          if (logger && logger.error) {
            logger.error(`Module ${m.name || '?'} onMessage error:`, e.message);
          }
        }
      }
    }
  }

  return { dispatch };
}

module.exports = createRuntime;
