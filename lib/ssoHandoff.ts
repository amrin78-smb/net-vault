//
// lib/ssoHandoff.ts — the claim set the three satellite handoffs mint.
//
// ⛔ ONE SHAPE, BECAUSE THREE SATELLITES PARSE IT AND ONE OF THEM NOW REFUSES A
// TOKEN THAT IS MISSING A FIELD. `app/api/sso/{logvault,ddivault,spanvault}`
// each built this object inline, so the only thing keeping them identical was
// that somebody copied the last one — and SpanVault's own
// `frontend/src/lib/auth.ts` requires `userId` AND `app === 'spanvault'` in the
// payload, so dropping or renaming either claim in one of the three routes
// breaks SpanVault sign-in entirely, with nothing in this repo failing.
//
// The claim set is therefore built here, asserted by name in
// `tests/systemSeams.test.ts`, and the routes carry only their own plumbing.
//
// ⛔ NOTHING IS IMPORTED HERE. The routes own `next/server`, `jsonwebtoken` and
// the origin resolver; this file has to stay importable from a plain test.

/** The satellites this hub can hand off to. `netvault` is the hub itself. */
export type SatelliteSlug = 'logvault' | 'ddivault' | 'spanvault'

/**
 * The signed payload, exactly as the satellites read it.
 *
 * ⛔ `userId`, NOT `id`, AND `app`, NOT `slug`. Both names are a contract with
 * code in three other repositories: LogVault selects
 * `FROM users WHERE id = <userId>`, DDIVault posts the token back to the hub's
 * /api/auth/sso-verify, and SpanVault's `authorize()` rejects the token unless
 * `userId` is present and `app` equals its own slug.
 */
export type SsoClaims = {
  userId: string
  email: string
  role: string
  name: string
  app: SatelliteSlug
  apps: string[]
}

/** Enumerated so a test can refuse a silently-renamed or dropped claim. */
export const SSO_CLAIM_KEYS: ReadonlyArray<keyof SsoClaims> = [
  'userId', 'email', 'role', 'name', 'app', 'apps',
]

/**
 * Long enough to survive a redirect, short enough that the URL it travels in is
 * not a credential. Unchanged — the satellites do not read it, but a longer
 * life would make every handoff URL in a proxy log a reusable session.
 */
export const SSO_TOKEN_TTL = '2m'

/** What a hub session has to carry before it can be handed to a satellite. */
export type HandoffIdentity = {
  id: string
  email: string
  role: string
  name: string
}

/**
 * Read a usable identity out of a hub session, or `null`.
 *
 * ⛔ `null` IS A REFUSAL, AND A MISSING `role` IS THE CASE IT EXISTS FOR. The
 * `jwt` callback in `[...nextauth]` CLEARS `token.role` when a directory
 * mapping has been revoked or a local account has been deleted — that is the
 * mid-session revocation layer, and it is the whole reason these routes must go
 * through `getServerSession` rather than `getToken`. But a session object with
 * a null role is still a session: left unchecked, the handoff would carry on
 * and mint a satellite token with `role: null`, which LogVault would store as
 * no role and SpanVault would quietly read as `payload.role || 'viewer'`. A
 * revocation that silently becomes "viewer on SpanVault" is not a revocation.
 *
 * ⛔ AND A MISSING `id` IS THE SAME KIND OF REFUSAL. SpanVault requires
 * `userId`; minting a token without one produces a sign-in failure on the
 * satellite with nothing explaining it on this side.
 */
export function handoffIdentity(sessionUser: unknown): HandoffIdentity | null {
  const u = (sessionUser || {}) as Record<string, unknown>
  const id = u.id === undefined || u.id === null ? '' : String(u.id).trim()
  const role = typeof u.role === 'string' ? u.role.trim() : ''
  if (id === '' || role === '') return null
  const email = typeof u.email === 'string' ? u.email : ''
  // The satellites display this; an empty one is cosmetic, a missing role is not.
  const name = typeof u.name === 'string' && u.name.trim() !== '' ? u.name : email || id
  return { id, email, role, name }
}

/** Build the payload. ⛔ The ONLY place these key names are written. */
export function ssoClaims(user: HandoffIdentity, app: SatelliteSlug, apps: string[]): SsoClaims {
  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    app,
    apps,
  }
}
