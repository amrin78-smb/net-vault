'use strict';
/**
 * core/runtime.js — server-push message router.
 *
 * transport.onMessage hands every parsed server message to dispatch(), which
 * handles the core-level control messages (restart, get_logs) and then forwards
 * EVERY message on to each loaded module's onMessage — so the span module still sees
 * config/discover exactly as the legacy agent did (agent.js:113-126), and future
 * modules receive their own pushes the same way.
 *
 * NOTE (Phase 3, Workstream B): self-update is NO LONGER triggered here. The legacy
 * span-WS `config.agent_bundle` branch has been retired — signed self-update is now
 * driven from the HUB control channel (core/hub.js's policy tick calls
 * updater.consider). The updater is wired into the hub client by nocvault-agent.js,
 * not into this runtime.
 */
function createRuntime({ config, transport, logger, modules }) {
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
