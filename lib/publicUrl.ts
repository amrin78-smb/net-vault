import { NextRequest } from 'next/server'

// A cross-app redirect target used to be built by string-replacing a port onto
// NetVault's own (install-time, IP-baked) NEXTAUTH_URL — so it always pointed at
// the original install IP no matter what hostname the browser actually used (a
// customer's own local-DNS name, for instance). This derives the correct origin
// from the CURRENT request instead, so it follows whatever hostname is in use.
//
// x-forwarded-host/-proto are checked first for reverse-proxy deployments (the app
// itself would otherwise only see the proxy's own local host/scheme); a lightweight
// hostname-shape check guards against a malformed/unexpected header value before it's
// used to build a redirect URL. Falls back to today's exact behavior if the request
// doesn't carry a usable Host — never worse than the status quo.
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

export function resolveOrigin(req: NextRequest, port: number | null, legacyFallback: string): string {
  const rawHost = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const hostname = rawHost.split(':')[0].trim()
  const proto = (req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '') || 'http')
    .split(',')[0]
    .trim()

  if (hostname && hostname.length <= 253 && HOSTNAME_RE.test(hostname) && (proto === 'http' || proto === 'https')) {
    return `${proto}://${hostname}${port ? ':' + port : ''}`
  }
  return legacyFallback
}

export const SIBLING_PORTS = { logvault: 3004, ddivault: 3006, spanvault: 3008 } as const
