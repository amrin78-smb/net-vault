//
// lib/terminatorState.ts — is the shared TLS front door there, and running?
//
// ⛔ SERVER ONLY. This spawns `sc.exe`; it must never be imported by a client
// component. `lib/tlsTransport.ts` is the client-safe half of this feature and
// deliberately imports nothing.
//
// ⛔ ONE IMPLEMENTATION, BECAUSE FOUR ROUTES NEED THE SAME ANSWER and the
// interesting part is the error handling, not the command. `sc.exe` exits 1060
// for a service that does not exist — that is an ANSWER. Every other failure
// (not Windows, no permission, sc.exe missing) is NOT an answer, and the whole
// value of this module is that the two never collapse into each other.
//
// ⛔ NO `execSync` ([[sync-exec-blocks-event-loop]]): a synchronous child
// process in a request handler blocks the event loop and surfaces as database
// pool timeouts somewhere unrelated.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The NSSM service that terminates TLS for all four consoles. */
export const TERMINATOR_SERVICE = 'NocVault-Tls'

/**
 * The hub's PUBLIC port — what a browser connects to.
 *
 * ⛔ NOT `process.env.PORT`. Behind the terminator that is the LOOPBACK port
 * (13000), and reporting it as the address anyone uses is the exact mistake
 * this module exists to stop.
 */
export const HUB_PUBLIC_PORT = 3000

export type TerminatorState = 'running' | 'stopped' | 'absent' | 'unknown'

export type TerminatorReading = {
  state: TerminatorState
  /** Why the state is `unknown`, when it is. */
  detail: string | null
  /** ⛔ `null` when unknown — never `false`. */
  present: boolean | null
  /** ⛔ `null` when unknown — never `false`. */
  running: boolean | null
}

export async function readTerminatorState(): Promise<TerminatorReading> {
  if (process.platform !== 'win32') {
    return { state: 'unknown', detail: 'Not a Windows host.', present: null, running: null }
  }
  try {
    const { stdout } = await execFileAsync('sc.exe', ['query', TERMINATOR_SERVICE], { timeout: 10_000 })
    if (/STATE\s*:\s*\d+\s+RUNNING/i.test(stdout)) {
      return { state: 'running', detail: null, present: true, running: true }
    }
    if (/STATE\s*:\s*\d+\s+(STOPPED|PAUSED)/i.test(stdout)) {
      return { state: 'stopped', detail: null, present: true, running: false }
    }
    if (/STATE\s*:\s*\d+\s+(START_PENDING|STOP_PENDING)/i.test(stdout)) {
      return { state: 'stopped', detail: 'The service is changing state.', present: true, running: false }
    }
    return {
      state: 'unknown',
      detail: 'sc.exe returned output this build does not recognise.',
      present: null,
      running: null,
    }
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
    const text = `${e?.stdout || ''}${e?.stderr || ''}`
    // 1060 = ERROR_SERVICE_DOES_NOT_EXIST. A real answer, and the common one on
    // an install that has never had HTTPS turned on.
    if (e?.code === 1060 || /1060/.test(text) || /does not exist as an installed service/i.test(text)) {
      return { state: 'absent', detail: null, present: false, running: false }
    }
    return {
      state: 'unknown',
      detail: (e?.message || 'sc.exe could not be run').slice(0, 200),
      present: null,
      running: null,
    }
  }
}

/**
 * Does a named service exist? Tri-state, for the same reason as above.
 *
 * ⛔ REPLACES AN EARLIER `serviceExists(): Promise<boolean>` THAT RETURNED
 * `false` ON NON-WINDOWS AND ON ANY EXCEPTION — the precise collapse this
 * module's header forbids, in this module, under an inviting name. It was also
 * dead (the restart route carried a private copy), so it was pure trap.
 */
export async function serviceExists(name: string): Promise<boolean | null> {
  if (process.platform !== 'win32') return null
  try {
    await execFileAsync('sc.exe', ['query', name], { timeout: 10_000 })
    return true
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    const text = `${e?.stdout || ''}${e?.stderr || ''}`
    if (e?.code === 1060 || /1060/.test(text) || /does not exist as an installed service/i.test(text)) {
      return false
    }
    return null
  }
}

export type DependencyReading = {
  /** ⛔ `null` when we could not tell — never `false`. */
  dependsOn: boolean | null
  detail: string | null
}

/**
 * Parse the dependency list out of `sc qc` output.
 *
 * ⛔ `sc qc` PRINTS EXTRA DEPENDENCIES ON UNLABELLED CONTINUATION LINES:
 *
 *     DEPENDENCIES       : NetVault
 *                        : LogVault-App
 *                        : DDIVault-App
 *
 * A parser that keys on the line containing `DEPENDENCIES` sees the FIRST
 * entry and silently misses the rest. That is not hypothetical — a display
 * filter with this exact bug made a failed `depend=` clear look like a partial
 * success on production. Collect the labelled line's value, then every
 * following unlabelled `: value` line, and stop at the next labelled field.
 */
export function parseScQcDependencies(stdout: string): string[] | null {
  const lines = String(stdout || '').split(/\r?\n/)
  const out: string[] = []
  let inDeps = false
  let sawLabel = false
  for (const line of lines) {
    const labelled = line.match(/^\s*([A-Z_]+)\s*:\s*(.*)$/)
    if (labelled) {
      if (/^DEPENDENCIES$/i.test(labelled[1])) {
        inDeps = true
        sawLabel = true
        const v = labelled[2].trim()
        if (v) out.push(v)
        continue
      }
      // Any OTHER labelled field ends the dependency block.
      if (inDeps) inDeps = false
      continue
    }
    if (inDeps) {
      const cont = line.match(/^\s*:\s*(.*)$/)
      if (cont) {
        const v = cont[1].trim()
        if (v) out.push(v)
        continue
      }
      if (!line.trim()) { inDeps = false; continue }
    }
  }
  // ⛔ NO LABEL AT ALL IS NOT AN EMPTY LIST. `sc.exe` LOCALISES ITS FIELD
  // NAMES (ABHAENGIGKEITEN, DEPENDANCES, ...), so on a non-English Windows the
  // label is simply absent from our regex's point of view. Saying "no
  // dependencies" there would be a guess presented as a fact.
  if (!sawLabel) return null
  return out
}

/**
 * Does the terminator declare a dependency on `service`?
 *
 * ⛔ THE CALLER DECIDES WHICH WAY `null` FALLS, AND THE TWO CALLERS CHOOSE
 * OPPOSITELY ON PURPOSE:
 *
 *   - An UPDATER must assume it DOES depend. Getting 1051 there means the app
 *     service never stopped, and the updater then rebuilds `node_modules`
 *     under a live process — real corruption. Stopping the terminator
 *     unnecessarily only costs a short outage it already warned about.
 *   - The RESTART BUTTON must assume it does NOT. A refused stop there is
 *     nothing worse than a restart that reports `failed`, which the operator
 *     can retry; stopping the terminator unnecessarily takes all four consoles
 *     down, which is the outage we removed in 1.61.1.
 */
export async function terminatorDependsOn(service: string): Promise<DependencyReading> {
  if (process.platform !== 'win32') {
    return { dependsOn: null, detail: 'Not a Windows host.' }
  }
  try {
    const { stdout } = await execFileAsync('sc.exe', ['qc', TERMINATOR_SERVICE], { timeout: 10_000 })
    const deps = parseScQcDependencies(stdout)
    if (deps === null) {
      return { dependsOn: null, detail: 'sc.exe did not print a dependency field this build recognises.' }
    }
    const hit = deps.some((d) => d.toLowerCase() === service.toLowerCase())
    return { dependsOn: hit, detail: null }
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
    const text = `${e?.stdout || ''}${e?.stderr || ''}`
    if (e?.code === 1060 || /1060/.test(text) || /does not exist as an installed service/i.test(text)) {
      // No terminator at all: it cannot depend on anything.
      return { dependsOn: false, detail: null }
    }
    return { dependsOn: null, detail: (e?.message || 'sc.exe could not be run').slice(0, 200) }
  }
}
