import { NextRequest, NextResponse } from 'next/server'
import { resolveOrigin } from '@/lib/publicUrl'
import { buildLinuxInstallScript } from '@/lib/agentInstallLinux'

export const dynamic = 'force-dynamic'

// GET /api/agents/install.sh — PUBLIC (no session). The Linux sibling of
// /api/agents/install.ps1: returns a bash installer as text/plain with the hub
// origin baked in. Public for the same reason the PowerShell one is — the remote
// host runs `curl` before it holds any credential, so there is no session to
// require; the security boundary is the one-time enrollment token in the minted
// command, not the route.
//
// WHY A LINUX AGENT EXISTS AT ALL: the agent's span module (ping / SNMP / service
// checks / discovery) is entirely protocol work, so it buys REACHABILITY, not new
// capability — a foothold inside a remote, NAT'd or segmented site. Until now the
// only way to get that foothold was a Windows Server at the site. The core and the
// span module were already portable (pure-JS deps — ws, ping, net-snmp — and every
// path is __dirname-relative), so what was missing was packaging, not a port.
//
// ⛔ THE ddi MODULE IS DELIBERATELY NOT AVAILABLE HERE. It is WinRM/DHCP-log/registry
// work whose whole value is being LOCAL to a Windows estate, and nocvault-agent.js
// only `require`s it inside `if (ddiEnabled)`, so a Linux agent never loads a line of
// it. DDIVault's Linux DNS support needs no agent either: collector/dns is
// protocol-first by design and explicitly "needs no agent on the customer's DNS
// server". --modules is still accepted and passed through verbatim so the hub stays
// the single source of truth, but see the guard below.
export async function GET(req: NextRequest) {
  const origin = resolveOrigin(req, 3000, process.env.NEXTAUTH_URL || 'http://localhost:3000')
  return new NextResponse(buildLinuxInstallScript(origin), {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
