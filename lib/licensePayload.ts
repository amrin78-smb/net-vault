//
// lib/licensePayload.ts — what `GET /api/license` is allowed to say, to whom.
//
// ⛔ THAT ROUTE'S `GET` HAD NO SESSION CHECK AT ALL. Its `POST` does (super_admin),
// which is why grepping the file for `getServerSession` passed — and the GET
// returned the whole licence record to anyone who could reach port 3000:
// `serverId` (this machine's fingerprint, hostname + MachineGuid hashed — the
// value a licence key is ISSUED against), `maxDevices`, `installDate`,
// `customer`, `expiry`, `modules`, `status`, `daysRemaining`. All three
// satellites then re-publish whatever they get on their OWN unauthenticated
// `/api/license-status`, so one unauthenticated hub response was reachable on
// four ports.
//
// ⛔ IT IS TRIMMED RATHER THAN AUTHENTICATED, AND THE REASON IS LOAD-BEARING.
// The satellites fetch this SERVER-TO-SERVER with no session and no credential
// of any kind (`logvault/api/licenseCheck.js`, `ddivault/api/licenseCheck.js`,
// `spanvault/api/licenseCheck.js` — all three do a bare
// `fetch(`${hubUrl}/api/license`)`), and each one FAILS OPEN on anything that is
// not a 2xx:
//
//     if (!res.ok) return null;          // -> getLicenseState(null)
//     { mode: 'unreachable', canWrite: true, canRead: true, disabled: false }
//
// So putting a session in front of this GET would not break the satellites
// loudly — it would turn every satellite's licence enforcement off, silently,
// in three other repositories, with nothing logged anywhere. There is no shared
// service credential on that path today to authenticate it WITH, and inventing
// one is a four-repository change.
//
// ⛔ WHICH FIELDS EACH SATELLITE ACTUALLY CONSUMES, checked against the code:
//   `status`, `daysRemaining`, `modules`   — all three `licenseCheck.js`
//                                            (`getLicenseState`)
//   `customer`, `expiry`, `trialDaysTotal` — all three `LicenseGuard.tsx`
//                                            (`LicenseInfo`, the banner)
// NOTHING in any satellite reads `serverId`, `maxDevices` or `installDate`.
// Those three are the ones removed from the unauthenticated answer, and they
// are exactly the three the hub needs only on its own super_admin screens
// (Settings → License, and the EOL Intelligence page's server-id block).
//
// ⛔ `customer` AND `expiry` STAY PUBLIC, DELIBERATELY. Trimming them would be
// no gain: every satellite re-publishes both on its own public
// `license-status`, which no change here can reach, and the banner that reads
// them ("Licensed to: …") is shown to unauthenticated visitors on those apps by
// design. Removing them from the hub would blank that banner in three products
// and move no secret.
//
// ⛔ NOTHING IS IMPORTED HERE. Pure shaping, so a test can exercise it.

/** Everything the hub knows. Built by the route, never sent as-is. */
export type LicenseFacts = {
  status: string
  daysRemaining: number
  serverId: string
  customer: string | null
  expiry: string | null
  modules: string[]
  maxDevices: number | null
  trialDaysTotal: number
  installDate: string | null
}

/** The answer any caller may have, session or not. */
export type PublicLicensePayload = {
  status: string
  daysRemaining: number
  customer: string | null
  expiry: string | null
  modules: string[]
  trialDaysTotal: number
}

/** The public answer plus the fields only the hub's own super_admin screens use. */
export type PrivilegedLicensePayload = PublicLicensePayload & {
  serverId: string
  maxDevices: number | null
  installDate: string | null
}

/**
 * The fields held back from an unauthenticated caller.
 *
 * ⛔ ENUMERATED SO A TEST CAN GO AND LOOK FOR THEM, rather than listing the
 * fields that are allowed and passing when a new one is added by accident.
 */
export const PRIVILEGED_LICENSE_FIELDS: ReadonlyArray<keyof PrivilegedLicensePayload> = [
  'serverId', 'maxDevices', 'installDate',
]

/**
 * ⛔ BUILT BY LISTING THE KEYS, NOT BY DELETING THEM FROM A COPY. A
 * `delete payload.serverId` shape re-leaks every field added to `LicenseFacts`
 * later, because the new field is in the spread and in nobody's delete list.
 */
export function publicLicensePayload(f: LicenseFacts): PublicLicensePayload {
  return {
    status: f.status,
    daysRemaining: f.daysRemaining,
    customer: f.customer,
    expiry: f.expiry,
    modules: f.modules,
    trialDaysTotal: f.trialDaysTotal,
  }
}

/** Everything, for a super_admin session only. */
export function privilegedLicensePayload(f: LicenseFacts): PrivilegedLicensePayload {
  return {
    ...publicLicensePayload(f),
    serverId: f.serverId,
    maxDevices: f.maxDevices,
    installDate: f.installDate,
  }
}

/**
 * Which shape a caller gets.
 *
 * ⛔ super_admin, MATCHING WHO CAN SEE THESE FIELDS IN THE UI. Settings →
 * License is gated `activeTab === 'license' && isSuperAdmin`, and the EOL page
 * fetches the server id only when `isSuperAdmin` — so no lesser session has a
 * screen that reads any of them, and widening this to `admin` would hand them
 * to a role with nowhere to show them.
 */
export function licensePayloadFor(role: string | null | undefined, f: LicenseFacts):
  PublicLicensePayload | PrivilegedLicensePayload {
  return role === 'super_admin' ? privilegedLicensePayload(f) : publicLicensePayload(f)
}
