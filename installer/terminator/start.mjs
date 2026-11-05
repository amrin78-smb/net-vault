//
// installer/terminator/start.mjs — the launcher NSSM points at.
//
//   node installer\terminator\start.mjs
//
// ⛔ THIS FILE IS PLAIN JAVASCRIPT ON PURPOSE, AND IT IS THE ONLY FILE HERE THAT
// IS. The terminator itself is TypeScript, because it must LOAD
// `lib/tlsConfig.ts` — the suite's one transport-decision layer — rather than
// carry a second copy of its judgement. Node can execute TypeScript directly
// from 22.6 (`--experimental-strip-types`), unflagged from 22.18 / 23.6;
// `Install-NocVault-Suite.ps1` bundles node-v20.19.0-x64.msi, and Node 20 never
// received that backport.
//
// On such a Node the import below fails with node's own
// `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"` — a message that
// says nothing about certificates, ports or what to do, logged by a service
// that then restarts for ever. This file exists so that the operator gets the
// real sentence instead. It is loadable by EVERY Node the installer has ever
// shipped, which is the whole point: a refusal nobody can read is not a
// refusal.
//
// ⛔ THE CAPABILITY IS DETECTED BY ATTEMPTING IT, NEVER BY A VERSION TABLE. A
// table of "which Node can strip types" is a second source of truth that goes
// stale (22.6 behind a flag, 22.18 unflagged, 23.6 unflagged, 20 never) and
// would refuse to start on a Node that works, or claim one that does not. The
// import is tried; only node's own verdict is believed.
//
// ⛔ AND IT REFUSES RATHER THAN SERVING PLAINTEXT, which does NOT contradict the
// degrade-to-HTTP rule one directory up. That rule covers a BROKEN CERTIFICATE:
// the transport state is known (`failed`), it is announced at error level every
// start, and plaintext is the honest fallback. Here the decision layer could not
// be loaded at all, so nothing knows whether a certificate is configured —
// serving plaintext in that state is the silent degrade the whole design
// forbids, and is indistinguishable from a deliberate `disabled` install. That
// is the exact shape of SecVault's 2026-09-24 outage, where a `.env.local` that
// would not parse brought an encrypted console up on plaintext saying nothing.
//

// ⛔ `pathToFileURL`, never `'file://' + argv[1]`. This runs on Windows, where
// argv[1] is `C:\Apps\NetVault\app\installer\terminator\start.mjs` — hand-built
// that is not a URL, the comparison below silently never matches, and the
// launcher becomes a file that imports nothing and exits 0 while NSSM reports
// the service as Running.
import { pathToFileURL } from 'node:url'

const TERMINATOR = './nocvault-tls-terminator.ts'

/**
 * Is this the failure that means "this Node cannot execute TypeScript"?
 *
 * Exported so a test can drive it with a synthetic error — the branch cannot be
 * reached on a Node that can load this project's own `.ts` files at all, so
 * without this it would be a guard that is never exercised anywhere.
 */
export function isTypeScriptUnsupported(err) {
  if (!err) return false
  if (err.code === 'ERR_UNKNOWN_FILE_EXTENSION') return true
  // Older/alternative wording, matched on the EXTENSION rather than the whole
  // sentence so a message reflow does not silently turn this into a crash.
  return /unknown file extension[^\n]*\.ts\b/i.test(String(err.message || ''))
}

export function unsupportedRuntimeMessage(nodeVersion) {
  const rule = '='.repeat(72)
  return [
    '',
    `  ${rule}`,
    '  NocVault TLS terminator: NOT STARTED. Nothing is being served.',
    `  This Node (${nodeVersion}) cannot execute TypeScript, so the suite's TLS`,
    '  decision layer (lib/tlsConfig.ts) could not be loaded.',
    '',
    '  It has NOT fallen back to plain HTTP: with that module unloadable it',
    '  cannot tell a configured certificate from an unconfigured one, and',
    '  serving plaintext would look exactly like a deliberate plain-HTTP',
    '  install.',
    '',
    '  Fix: install Node 22.18 LTS or newer on this server (the suite installer',
    '  bundles 20.19.0), then restart the NocVault-Tls service. The four',
    '  consoles keep serving on their own ports meanwhile.',
    `  ${rule}`,
    '',
  ].join('\n')
}

async function main() {
  let terminator
  try {
    terminator = await import(TERMINATOR)
  } catch (err) {
    if (isTypeScriptUnsupported(err)) {
      console.error(unsupportedRuntimeMessage(process.version))
      process.exit(1)
    }
    // ⛔ Anything else is RETHROWN. A wrong diagnosis ("upgrade your Node")
    // for a missing file or a syntax error sends the next person to fix the
    // wrong thing, which is worse than the raw stack trace.
    throw err
  }

  // ⛔ CALL IT EXPLICITLY. The terminator's own entry guard fires only when IT
  // is argv[1], which it is not here, so an import alone starts nothing: the
  // first version of this launcher loaded the module, bound no ports, logged
  // nothing, exited 0 — and NSSM would have reported the service Running.
  await terminator.run()
}

// Only run when this file IS the entry point, so the two helpers above can be
// imported by a test without launching four listeners.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(
      `[nocvault-tls] failed to start: ${err && err.stack ? err.stack : String(err)}`,
    )
    process.exit(1)
  })
}
