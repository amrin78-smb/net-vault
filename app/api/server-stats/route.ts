import { NextResponse } from 'next/server'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { execSync } from 'child_process'

// Public server-metrics endpoint (no auth) — mirrors /api/health's openness.
// Runs on Node (needs child_process + os); never prerender/cache.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── DISK ─────────────────────────────────────────────────────────────
// Mirrors LogVault's approach (api/server.js /api/stats/disk): shell out to
// PowerShell Get-PSDrive for real C: drive usage. Windows host (192.168.6.111).
function readDisk(): { total: number; used: number; free: number; percent: number; path: string } | null {
  try {
    const ps =
      `powershell.exe -NonInteractive -Command "` +
      `$d = Get-PSDrive C; ` +
      `$used = $d.Used; $free = $d.Free; $total = $used + $free; ` +
      `Write-Output ($used.ToString() + ',' + $free.ToString() + ',' + $total.ToString())" `
    const output = execSync(ps, { encoding: 'utf8', timeout: 10000 }).trim()
    const [used, free, total] = output.split(',').map((v) => parseInt(v.trim(), 10))
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null
    return { total, used, free, percent: Math.round((used / total) * 100), path: 'C:' }
  } catch {
    return null
  }
}

// ── CPU ──────────────────────────────────────────────────────────────
// Sample cpu times across a short interval to get a live utilization %.
function cpuSnapshot(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t
    idle += c.times.idle
  }
  return { idle, total }
}

async function cpuPercent(): Promise<number> {
  const a = cpuSnapshot()
  await new Promise((r) => setTimeout(r, 200))
  const b = cpuSnapshot()
  const idle = b.idle - a.idle
  const total = b.total - a.total
  if (total <= 0) return 0
  return Math.round((1 - idle / total) * 100)
}

// ── DISK FORECAST ────────────────────────────────────────────────────
// Persist a small rolling history of disk usage, then linear-regress to
// estimate days until full. Returns null when growth is negligible or there
// isn't enough history yet. Failures degrade silently to null.
async function diskForecastDays(usedBytes: number, freeBytes: number): Promise<number | null> {
  try {
    const dir = path.join(process.cwd(), '.data')
    const file = path.join(dir, 'disk-history.json')
    await fs.mkdir(dir, { recursive: true })

    let hist: { t: number; used: number }[] = []
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (Array.isArray(parsed)) hist = parsed
    } catch {
      /* first run or unreadable — start fresh */
    }

    const now = Date.now()
    hist.push({ t: now, used: usedBytes })
    const cutoff = now - 30 * 86400000 // keep last 30 days
    hist = hist.filter((h) => h && typeof h.t === 'number' && h.t >= cutoff)
    if (hist.length > 1000) hist = hist.slice(hist.length - 1000)
    await fs.writeFile(file, JSON.stringify(hist))

    const spanMs = hist[hist.length - 1].t - hist[0].t
    if (hist.length < 3 || spanMs < 3600000) return null // need >= 1h of history

    // Least-squares slope of used-bytes over time (bytes per ms).
    const n = hist.length
    const t0 = hist[0].t
    let sx = 0
    let sy = 0
    let sxy = 0
    let sxx = 0
    for (const h of hist) {
      const x = h.t - t0
      const y = h.used
      sx += x
      sy += y
      sxy += x * y
      sxx += x * x
    }
    const denom = n * sxx - sx * sx
    if (denom === 0) return null
    const slope = (n * sxy - sx * sy) / denom
    const perDay = slope * 86400000
    if (perDay <= 10 * 1024 * 1024) return null // < 10 MB/day → negligible

    const days = freeBytes / perDay
    if (!Number.isFinite(days) || days <= 0) return null
    return Math.round(days)
  } catch {
    return null
  }
}

export async function GET() {
  try {
    const disk = readDisk()
    const cpu = await cpuPercent()

    const total = os.totalmem()
    const free = os.freemem()
    const used = total - free
    const memory = {
      total,
      used,
      free,
      percent: total > 0 ? Math.round((used / total) * 100) : 0,
    }

    const disk_forecast_days = disk ? await diskForecastDays(disk.used, disk.free) : null

    return NextResponse.json({
      disk: disk ?? { total: 0, used: 0, free: 0, percent: 0, path: 'C:' },
      memory,
      cpu: { percent: cpu },
      uptime_seconds: Math.round(os.uptime()),
      disk_forecast_days,
    })
  } catch {
    return NextResponse.json({ error: 'Unable to read server metrics' }, { status: 200 })
  }
}
