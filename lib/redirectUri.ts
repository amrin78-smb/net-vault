//
// lib/redirectUri.ts — will Microsoft Entra ID accept this Redirect URI?
//
// ⛔ ZERO IMPORTS, DELIBERATELY. This is shared by an API route and by a
// 'use client' Settings panel. It lived in lib/entraSettings.ts first, which
// reaches node:fs through envFile.ts — and a client component importing that
// drags the Node fs shim into the browser bundle. (Measured on the sibling
// case: importing lib/directoryRefusals.ts into a client component pulled in
// the whole pg driver and failed the Turbopack build with 6 errors.) Nothing
// may be imported here.
//
//
// ⛔ MICROSOFT ENTRA ID WILL NOT ACCEPT AN IP ADDRESS AS A REDIRECT URI, AND
// EVERY NOCVAULT INSTALL STARTS LIFE ON ONE. `NEXTAUTH_URL` is baked to the
// server's IP at install time, so `redirectUriFor()` derives something like
// `https://192.168.6.111:3000/api/auth/callback/entra` — and the panel shows it
// as the string to register, confidently, when it cannot be registered at all.
//
// The failure mode this prevents is the worst-shaped one in the whole feature:
// it fails on MICROSOFT'S side. The administrator pastes the URI, the portal
// refuses it, and nothing about that reaches this server — there is no log
// line, no audit row, nothing for anyone here to go on. The same is true of the
// scheme: a non-loopback redirect URI must be https, so an install that has not
// had its TLS cutover cannot use single sign-on either.
//
// Verified in the field on SecVault before it was written down here.
//
// ⛔ PURE, AND IT ONLY CLASSIFIES. It does not block saving anything: a customer
// may legitimately set the console address first and the certificate second, and
// refusing to store a tenant id because the hostname is not ready yet would be
// an obstacle rather than a guard.

export type RedirectHostKind = 'none' | 'loopback' | 'ip' | 'single-label' | 'dns'

export type RedirectUriVerdict = {
  uri: string | null
  host: string | null
  scheme: string | null
  kind: RedirectHostKind
  /** Will the Entra portal accept this string in an app registration? */
  registrable: boolean
  /** Complete sentences, in the order they should be shown. */
  problems: string[]
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

export function classifyRedirectUri(uri: string | null | undefined): RedirectUriVerdict {
  const raw = String(uri || '').trim()
  if (!raw) {
    return { uri: null, host: null, scheme: null, kind: 'none', registrable: false, problems: [] }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {
      uri: raw, host: null, scheme: null, kind: 'none', registrable: false,
      problems: ['This does not parse as a URL, so the console address it is built from is not a usable address.'],
    }
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  // URL.hostname strips the brackets from an IPv6 literal, which is what makes
  // a ':' test on it safe.
  const host = parsed.hostname.toLowerCase()
  const problems: string[] = []

  const isLoopback =
    host === 'localhost' || host === '::1' || /^127\./.test(host)
  const isIpv6 = host.includes(':')
  const isIp = IPV4_RE.test(host) || isIpv6

  let kind: RedirectHostKind
  if (isLoopback) kind = 'loopback'
  else if (isIp) kind = 'ip'
  else if (!host.includes('.')) kind = 'single-label'
  else kind = 'dns'

  if (kind === 'ip') {
    problems.push(
      'Microsoft Entra ID will not accept an IP address as a Redirect URI. The app registration '
      + 'needs a hostname with a domain, so single sign-on cannot work until the console address '
      + 'is one.',
    )
  } else if (kind === 'single-label') {
    problems.push(
      `“${parsed.hostname}” is a single name with no domain. Entra needs a fully qualified `
      + 'hostname, such as nocvault.example.com.',
    )
  } else if (kind === 'loopback') {
    problems.push(
      'This Redirect URI points at the server itself, so it would only work for a browser running '
      + 'on that machine. Set the console address to the hostname people actually type.',
    )
  }

  // ⛔ CHECKED FOR EVERY NON-LOOPBACK HOST, INCLUDING A PERFECTLY GOOD ONE.
  // Entra requires https for a Web redirect URI and makes loopback the only
  // exception, so a correct hostname still cannot be registered over http —
  // which is exactly the state of an install whose TLS cutover has not run.
  if (!isLoopback && scheme !== 'https') {
    problems.push(
      `Entra requires a Redirect URI to use https; this one uses ${scheme}. Install a certificate `
      + 'under Settings → Certificate so the consoles are served over HTTPS.',
    )
  }

  return { uri: raw, host: parsed.hostname, scheme, kind, registrable: problems.length === 0, problems }
}
