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

/** Does a named service exist at all? Used before offering to restart it. */
export async function serviceExists(name: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    await execFileAsync('sc.exe', ['query', name], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}
