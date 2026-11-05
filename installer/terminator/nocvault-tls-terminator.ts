//
// installer/terminator/nocvault-tls-terminator.ts — the process NSSM runs.
//
// NSSM points at ./start.mjs, which is plain JavaScript and loads this file;
// run directly it is:
//
//   node installer/terminator/nocvault-tls-terminator.ts
//
// Everything that decides anything lives in ./tlsTerminator.ts (listeners,
// demux, proxy) and ../../lib/tlsConfig.ts (the transport state). This file is
// the shell: load the environment, start the listeners, stop them on a signal.
//
// ⛔ RUNTIME REQUIREMENT, AND IT IS NOT SATISFIED BY THE NODE THE INSTALLER
// SHIPS TODAY. The transport decision is `lib/tlsConfig.ts`, a TypeScript
// module, and this process must LOAD it rather than carry a second copy of its
// judgement. Node can execute TypeScript directly from 22.6
// (`--experimental-strip-types`), unflagged from 22.18 / 23.6;
// `Install-NocVault-Suite.ps1` bundles node-v20.19.0-x64.msi, and Node 20 never
// received that backport — so on a stock install the IMPORTS BELOW THROW before
// any code here runs, and nothing in this file can catch that. ./start.mjs
// exists to turn that into a sentence an operator can act on; read its header.
//
// It is REPORTED rather than worked around, because every way around it is
// worse: a hand-rolled type stripper is a second parser disagreeing with the
// authoritative one; an emitted `.js` copy is the build step this is required
// not to have; and a re-implementation of `resolveTlsConfig` is the mirror
// `scripts/test-mfa.cjs` already warns about in its own header ("if you change
// the algorithm there, this must be updated in lockstep or it is verifying a
// copy that no longer ships"). The installer owns the Node version; the fix is
// to bundle a current Node 22 LTS.
//
// ⛔ LOAD THE ENV FILES BEFORE READING ANY OF THEM. `next start` and the Next
// standalone server do this themselves; a standalone script must do it
// explicitly, and this one reads TLS_CERT_PATH at startup. SecVault lost a
// production console to exactly this omission: the TLS paths lived in
// `.env.local`, `resolveTlsConfig` saw an empty `process.env`, reported "TLS:
// not configured", the console came up on plain HTTP and the updater's HTTPS
// probe correctly found nothing. The local test had passed because the shell
// exported the variables — a test that supplies configuration differently from
// production is not testing the path production takes.
//
// ⛔ THE SERVICE ENVIRONMENT WINS OVER BOTH FILES. `lib/envTargets.ts` records
// that one logical setting lives in three places on NetVault and that the NSSM
// service environment is read at runtime and beats any file, because dotenv
// does not override an existing `process.env` value. This file copies that rule
// exactly: a key already present in `process.env` is never replaced.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseEnv, type EnvValues } from '../../lib/envFile.ts'
import type { TlsEnv } from '../../lib/tlsConfig.ts'
import { rootEnvPath, standaloneEnvPath } from '../../lib/envTargets.ts'
import { consoleLog, startTerminator, type UpstreamHandle } from './tlsTerminator.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** installer/terminator -> the install root. */
const INSTALL_ROOT = path.resolve(HERE, '..', '..')

/**
 * Read an env file if it exists, ignoring it if it does not.
 *
 * An absent file is NORMAL (a dev checkout has no `.next/standalone`), so it is
 * not an error. An UNREADABLE one is reported — a permissions problem on the
 * file holding the TLS paths is exactly the cause that must not present as "TLS
 * was never configured".
 */
function readIfPresent(filePath: string): EnvValues {
  try {
    if (!fs.existsSync(filePath)) return {}
    return parseEnv(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    consoleLog.error(
      `[nocvault-tls] could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return {}
  }
}

/**
 * The environment the terminator resolves from.
 *
 * Order, least significant first: `<root>/.env` (the deploy source
 * Update-NetVault.ps1 copies from), `.next/standalone/.env.local` (what the hub
 * process actually reads), then `process.env` — the NSSM service environment,
 * which wins.
 */
export function loadEnvironment(installRoot = INSTALL_ROOT): TlsEnv {
  let rootFile = path.join(installRoot, '.env')
  let standaloneFile = path.join(installRoot, '.next', 'standalone', '.env.local')
  try {
    // Prefer the repo-root resolution the rest of the app uses, so the
    // terminator reads the same two files the Settings writers write.
    rootFile = rootEnvPath(installRoot)
    standaloneFile = standaloneEnvPath(installRoot)
  } catch {
    // Not a git checkout (an unpacked zip install) — the path guesses above
    // are already correct for that shape.
  }

  const merged: TlsEnv = {
    ...readIfPresent(rootFile),
    ...readIfPresent(standaloneFile),
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}

/**
 * Start everything and stay up until a signal.
 *
 * ⛔ EXPORTED, AND `start.mjs` CALLS IT. The direct-invocation guard at the
 * bottom only fires when THIS file is `process.argv[1]`, which it is not when
 * the launcher imports it — relying on an import side effect meant the service
 * loaded cleanly, bound nothing, logged nothing and reported Running. Measured,
 * not reasoned about: the first launcher smoke run did exactly that.
 */
export async function run(): Promise<void> {
  const env = loadEnvironment()
  const handles = await startTerminator(env)

  if (handles.length === 0) {
    consoleLog.error('[nocvault-tls] no listener could be started — nothing is being served.')
    process.exitCode = 1
    return
  }

  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    consoleLog.info(`[nocvault-tls] ${signal} — closing ${handles.length} listener(s)`)
    Promise.all(handles.map((handle: UpstreamHandle) => handle.close())).then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

// ⛔ Only run when this file IS the process entry point, so a test can import
// `loadEnvironment` without binding four ports as a side effect of the import.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  run().catch((err: unknown) => {
    consoleLog.error(
      `[nocvault-tls] failed to start: ${err instanceof Error ? (err.stack || err.message) : String(err)}`,
    )
    process.exit(1)
  })
}
