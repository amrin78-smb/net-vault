//
// app/api/system/service-restart/route.ts — "apply it now" for the settings
// that are inert until a service restarts.
//
// NEXTAUTH_URL, the ENTRA_* values and a replaced certificate are all read once
// at startup. Saving one leaves the panel honest but stuck: "restart the
// NetVault service" is not something a customer can do from the product they
// bought, and it is the last step of three different settings flows.
//
// ⛔ AND IT IS NOT ALWAYS THE SAME SERVICE. A certificate is served by
// NocVault-Tls, never by NetVault — see `resolveRestartTarget`. The Certificate
// panel told an operator to restart NetVault after installing a real wildcard
// certificate on production (2026-11-06); following that restarts the wrong
// process and the old certificate keeps being served.
//
// ⛔ THE RESTART CANNOT BE AWAITED when the target is the hub: the service
// being restarted is the one serving the request. It goes to a SYSTEM
// scheduled task — the same shape as tls-transport and the in-app updater —
// and the panel watches for the console coming back.
//
// ⛔ NO `execSync` ON THIS PATH ([[sync-exec-blocks-event-loop]]).

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { findGitRoot } from '@/lib/gitRoot'
import { recordSystemChanges } from '@/lib/systemAudit.ts'
import {
  HUB_SERVICE,
  RESTART_PURPOSES,
  RESTART_TASK_NAME,
  TERMINATOR_SERVICE,
  buildRestartWrapper,
  isRestartPurpose,
  parseRestartLog,
  resolveRestartTarget,
  restartPaths,
} from '@/lib/serviceRestart.ts'

const execFileAsync = promisify(execFile)

type SessionUser = { id?: string | number; role?: string }
function userOf(session: unknown): SessionUser {
  return ((session as { user?: SessionUser } | null)?.user || {}) as SessionUser
}

/**
 * Whether the terminator exists at all.
 *
 * ⛔ A FAILED READ IS `null`, NOT `false`. "We could not ask" and "it is not
 * installed" lead to different advice for a certificate change, and treating
 * the first as the second tells an operator their new certificate needs no
 * action when it may need a restart.
 */
async function terminatorPresent(): Promise<boolean | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync('sc.exe', ['query', TERMINATOR_SERVICE], { timeout: 10_000 })
    return /SERVICE_NAME/i.test(stdout) || /STATE/i.test(stdout)
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    const text = `${e?.stdout || ''}${e?.stderr || ''}`
    if (e?.code === 1060 || /1060/.test(text) || /does not exist as an installed service/i.test(text)) return false
    return null
  }
}

async function serviceExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('sc.exe', ['query', name], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    return (e as { code?: string })?.code === 'EPERM'
  }
}

/**
 * What a restart would do, per purpose, and what the last one did.
 *
 * ⛔ THE PANEL POLLS THIS THROUGH THE RESTART, so for most of a hub restart
 * this route is simply unreachable — a failed fetch IS the expected signal and
 * the panel renders it as progress, not as a fault.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = userOf(session).role
  if (role !== 'admin' && role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const paths = restartPaths(findGitRoot(process.cwd()))
  const pid = readLockPid(paths.lock)
  let text: string | null = null
  try {
    if (fs.existsSync(paths.log)) text = fs.readFileSync(paths.log, 'utf8')
  } catch { text = null }
  const report = parseRestartLog(text)
  const present = await terminatorPresent()

  const targets: Record<string, { service: string | null; why: string }> = {}
  for (const purpose of RESTART_PURPOSES) {
    targets[purpose] = resolveRestartTarget(purpose, present === true)
  }

  return NextResponse.json({
    available: process.platform === 'win32',
    terminatorPresent: present,
    targets,
    inProgress: pid !== null && isPidAlive(pid),
    // ⛔ So the panel can prove the hub answering it is a NEW process rather
    // than the old one that never went down. "The page loaded again" is not
    // evidence that anything restarted.
    uptimeSeconds: Math.floor(process.uptime()),
    lastRun: { outcome: report.outcome, finished: report.finished, lines: report.lines.slice(-20) },
  })
}

/**
 * Restart the service that applies `purpose`.
 *
 * ⛔ super_admin. This interrupts service for everyone. An `admin` may save a
 * console address (an outage is not a privilege escalation, which is why that
 * route is admin+), but deciding to bounce a service for the whole site is a
 * step beyond editing a value.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = userOf(session)
  if (user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (process.platform !== 'win32') {
    return NextResponse.json(
      { error: 'Restarting a service is only available on the Windows host that runs it.' },
      { status: 400 },
    )
  }

  let body: { purpose?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }
  if (!isRestartPurpose(body.purpose)) {
    return NextResponse.json(
      { error: `purpose must be one of: ${RESTART_PURPOSES.join(', ')}.` },
      { status: 400 },
    )
  }
  const purpose = body.purpose

  const present = await terminatorPresent()
  const target = resolveRestartTarget(purpose, present === true)
  if (!target.service) {
    // Not an error — there is genuinely nothing to restart, and saying so is
    // more useful than bouncing a service for no effect.
    return NextResponse.json({ started: false, service: null, reason: target.why })
  }
  if (!(await serviceExists(target.service))) {
    return NextResponse.json(
      { error: `The ${target.service} service is not installed on this host, so there is nothing to restart.` },
      { status: 409 },
    )
  }

  const paths = restartPaths(findGitRoot(process.cwd()))
  const pid = readLockPid(paths.lock)
  if (pid !== null && isPidAlive(pid)) {
    return NextResponse.json({ error: `A restart is already running (process ${pid}).` }, { status: 409 })
  }

  try {
    fs.mkdirSync(paths.log.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
    fs.writeFileSync(
      paths.wrapper,
      buildRestartWrapper({
        service: target.service,
        log: paths.log,
        lock: paths.lock,
        taskName: RESTART_TASK_NAME,
        // ⛔ THE TERMINATOR DEPENDS ON THE HUB, so Windows refuses to stop the
        // hub while it runs (1051). Stopping it first and starting it after is
        // what makes a hub restart actually restart anything.
        dependents: target.service === HUB_SERVICE && present === true ? [TERMINATOR_SERVICE] : [],
      }),
      'utf8',
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Could not write the restart script: ${message}` }, { status: 500 })
  }

  try {
    try {
      await execFileAsync('schtasks.exe', ['/delete', '/tn', RESTART_TASK_NAME, '/f'], { timeout: 15_000 })
    } catch { /* no such task is the normal case */ }
    await execFileAsync('schtasks.exe', [
      '/create', '/tn', RESTART_TASK_NAME,
      '/tr', `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${paths.wrapper}"`,
      '/sc', 'once', '/st', '00:00', '/f', '/ru', 'SYSTEM',
    ], { timeout: 20_000 })
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string }
    return NextResponse.json(
      { error: `Could not schedule the restart: ${(e?.stderr || e?.message || '').toString().slice(0, 300)}` },
      { status: 500 },
    )
  }

  // ⛔ AUDITED BEFORE THE TASK RUNS, NOT AFTER. From the moment
  // `schtasks /run` succeeds this process can be killed at any instant, and an
  // audit write queued after it is one that may never happen — "who restarted
  // the console, and why" is exactly what an audit log is read for.
  try {
    await recordSystemChanges(user.id, [{ key: purpose, from: null, to: target.service }], 'service_restart')
  } catch { /* never block the restart on the audit row */ }

  try {
    await execFileAsync('schtasks.exe', ['/run', '/tn', RESTART_TASK_NAME], { timeout: 20_000 })
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string }
    return NextResponse.json(
      { error: `Could not start the restart: ${(e?.stderr || e?.message || '').toString().slice(0, 300)}` },
      { status: 500 },
    )
  }

  return NextResponse.json({
    started: true,
    service: target.service,
    why: target.why,
    // ⛔ Whether THIS request's own process is the one going down decides the
    // entire client experience: a hub restart means the page loses contact, a
    // terminator restart means a few seconds of 502 on the public port.
    selfRestart: target.service !== TERMINATOR_SERVICE,
    previousUptimeSeconds: Math.floor(process.uptime()),
  })
}
