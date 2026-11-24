//
// lib/consoles.ts — the four consoles, as facts that do not depend on how any
// of them was installed.
//
// ⛔ WHY THIS EXISTS AT ALL. A satellite's `NEXTAUTH_URL` carries NO
// independent information: it is exactly `<hub scheme>://<hub host>:<that
// app's public port>`. Nothing in the product could set the other three, so
// production drifted — the hub on the public FQDN, all three satellites still
// on the raw install-time server IP, which leaks that IP into every NextAuth
// `callbackUrl` and sends users to an address the certificate does not cover.
// The hub owns all four now, and this module is the one place that says which
// four and on what ports.
//
// ⛔ NO PATHS IN HERE, AND THAT IS THE WHOLE DISCIPLINE OF THIS FILE. Install
// paths are NOT uniform across the suite — `C:\Apps\NetVault\app` and
// `C:\Apps\SpanVault\app`, but `C:\Apps\logvault` and `C:\Apps\ddivault` with
// no `app` subfolder — and a hub that pattern-matched a path would write a
// setting into a directory that does not exist on half the installs, or worse
// into the wrong one. Every path is derived at RUNTIME from the service's own
// NSSM `AppDirectory` (lib/envTargets.ts `serviceAppDirectory`), the same way
// `Get-NssmForService` in all four updaters locates nssm.exe from the service
// `ImagePath` rather than guessing where it was installed.
//
// ⛔ THE PORTS ARE IMPORTED, NOT RESTATED. `SIBLING_PORTS` in lib/publicUrl.ts
// is what the SSO handoffs and the launcher already build their URLs from. A
// second copy of 3004/3006/3008 here would be a second answer to "where is
// LogVault", and the two would eventually disagree — in this feature the
// disagreement is a console address pointing at another app's port, which
// bounces every sign-in with no error anywhere.
//
// ⛔ CLIENT-SAFE ON PURPOSE: this imports nothing but `lib/publicUrl.ts`, whose
// only Next import is a `import type`. It must stay that way — `lib/serviceRestart.ts`
// imports this module and is reachable from a `'use client'` component, so a
// `node:child_process` anywhere in this import graph breaks the browser build.

import { SIBLING_PORTS } from './publicUrl.ts'

export type ConsoleSlug = 'netvault' | 'logvault' | 'ddivault' | 'spanvault'

export const HUB_SLUG: ConsoleSlug = 'netvault'

/** Every console, hub first. The ORDER is the order writes and restarts happen in. */
export const CONSOLE_SLUGS: readonly ConsoleSlug[] = ['netvault', 'logvault', 'ddivault', 'spanvault'] as const

export type ConsoleFacts = {
  slug: ConsoleSlug
  /** What the operator calls it. */
  label: string
  /**
   * The NSSM service that runs the console (the Next.js process).
   *
   * ⛔ THE SERVICE NAMES ARE NOT A PATTERN. The hub's is bare `NetVault`; the
   * three satellites carry an `-App` suffix because each of them also runs an
   * API and/or a collector service. Deriving these from the slug would be
   * wrong for the hub and right-by-accident for the rest.
   */
  service: string
  /** What a browser connects to. Never the loopback port behind the terminator. */
  publicPort: number
  /**
   * Other services that read the SAME `NEXTAUTH_URL` and therefore have to
   * restart with the console.
   *
   * ⛔ SPANVAULT'S EXPRESS API IS NOT OPTIONAL HERE. `spanvault/api/rbacScope.js`
   * (`trustedFetchHostnames`) puts `NEXTAUTH_URL` into the SSRF allow-list that
   * decides which hostnames a server-side fetch may use, and `api/server.js`
   * dotenv-loads the SAME root `.env.local` this feature writes. Change the
   * address, restart only `SpanVault-App`, and the API goes on trusting the old
   * hostname and refusing the new one — with the symptom appearing on
   * unauthenticated routes (middleware's PUBLIC_API), i.e. sign-in itself.
   *
   * ⛔ AND LOGVAULT'S COLLECTOR IS THE SAME CLASS, FOUND BY LOOKING RATHER THAN
   * BY ASSUMING THE CONSOLE WAS THE ONLY READER. `logvault/collector/emailer.js`
   * builds the links in every alert email from `appUrl()` =
   * `process.env.NEXTAUTH_URL`, and `collector.js` dotenv-loads
   * `<root>/.env.local` — the deploy-source file this feature writes, with
   * `AppDirectory` = the install root. Restart only `LogVault-App` and every
   * alert email keeps pointing at the old address, which is the one symptom
   * nobody sees in the product.
   *
   * ⛔ THIS LIST IS "WHO READS THE VALUE", NOT "WHO BELONGS TO THE APP". DDIVault
   * has no second reader (checked: no `NEXTAUTH_URL` outside its frontend), and
   * SpanVault's collector has none either — so neither is listed, because
   * restarting a service for a value it does not read is an outage for nothing.
   * If a new process starts reading `NEXTAUTH_URL`, it belongs here.
   */
  companionServices: readonly string[]
  isHub: boolean
}

export const CONSOLES: Record<ConsoleSlug, ConsoleFacts> = {
  netvault: {
    slug: 'netvault',
    label: 'NetVault',
    service: 'NetVault',
    // ⛔ THE HUB'S PUBLIC PORT LIVES HERE AND `lib/terminatorState.ts` RE-EXPORTS
    // IT. It is not in `SIBLING_PORTS` (which is, by its name, the OTHER three),
    // and it was previously declared in terminatorState beside a comment about
    // not confusing it with the loopback port. One declaration, two names, no
    // chance of drift.
    publicPort: 3000,
    companionServices: [],
    isHub: true,
  },
  logvault: {
    slug: 'logvault',
    label: 'LogVault',
    service: 'LogVault-App',
    publicPort: SIBLING_PORTS.logvault,
    companionServices: ['LogVault-Collector'],
    isHub: false,
  },
  ddivault: {
    slug: 'ddivault',
    label: 'DDIVault',
    service: 'DDIVault-App',
    publicPort: SIBLING_PORTS.ddivault,
    companionServices: [],
    isHub: false,
  },
  spanvault: {
    slug: 'spanvault',
    label: 'SpanVault',
    service: 'SpanVault-App',
    publicPort: SIBLING_PORTS.spanvault,
    companionServices: ['SpanVault-API'],
    isHub: false,
  },
}

/**
 * A slug out of a request body, or `null`.
 *
 * ⛔ A CLOSED ENUM, AND THAT IS WHAT MAKES IT SAFE TO PUT IN A REQUEST BODY AT
 * ALL. `lib/serviceRestart.ts`'s rule is that a service NAME is never a request
 * field — a route that restarts whatever service a caller names is a
 * denial-of-service primitive. A slug is not a service name: it is one of four
 * constants, and the slug→service mapping lives here, in code.
 */
export function asConsoleSlug(value: unknown): ConsoleSlug | null {
  return typeof value === 'string' && (CONSOLE_SLUGS as readonly string[]).includes(value)
    ? (value as ConsoleSlug)
    : null
}

export function isConsoleSlug(value: unknown): value is ConsoleSlug {
  return asConsoleSlug(value) !== null
}

/** The satellites, in order. */
export const SATELLITE_SLUGS: readonly ConsoleSlug[] = CONSOLE_SLUGS.filter((s) => !CONSOLES[s].isHub)

/**
 * Every service that has to restart for one console's address to take effect.
 *
 * ⛔ THE CONSOLE FIRST, ITS COMPANIONS AFTER, because that is the order the
 * restart wrapper walks the list in and the console is the process a user is
 * waiting on.
 */
export function consoleRestartServices(slug: ConsoleSlug): string[] {
  const c = CONSOLES[slug]
  return [c.service, ...c.companionServices]
}

/** Which console a service belongs to, or `null` for anything else (the terminator). */
export function consoleForService(service: string): ConsoleFacts | null {
  for (const slug of CONSOLE_SLUGS) {
    const c = CONSOLES[slug]
    if (c.service === service || c.companionServices.includes(service)) return c
  }
  return null
}
