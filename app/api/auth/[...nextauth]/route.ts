import NextAuth from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import AzureADProvider from 'next-auth/providers/azure-ad'
import { query } from '@/lib/db'
import { getUserApps } from '@/lib/appAccess'
import { verifySecondFactor, mfaRequiredForRole } from '@/lib/mfaGate'
import bcrypt from 'bcryptjs'
import { isEntraConfigured } from '@/lib/entraSettings.ts'
import {
  resolveDirectoryRole,
  isDirectoryRolePermitted,
  groupsFromClaims,
  type DirectoryClaims as GroupClaims,
  type RoleDecision,
} from '@/lib/directoryRoles.ts'
import { recordDirectoryRefusal } from '@/lib/directoryRefusals.ts'
import {
  decideDirectoryUser,
  isDirectoryPermitted,
  canUsePassword,
  mfaPolicyApplies,
  type Role,
} from '@/lib/directoryUser.ts'
import {
  loadDirectoryMappings,
  loadDirectoryContext,
  createDirectoryUser,
  refreshDirectoryUserRole,
} from '@/lib/directoryStore.ts'

//
// ⛔ THE PROVIDER ID IS A PUBLIC CONTRACT WITH EVERY CUSTOMER'S TENANT.
//
// NextAuth derives the OAuth redirect URI from it:
//   <NEXTAUTH_URL>/api/auth/callback/entra
// and that exact string is pasted into the app registration in the customer's
// Entra tenant at setup time. Renaming this constant silently invalidates every
// existing registration, and the failure surfaces on MICROSOFT's side ("the
// reply URL does not match") rather than in our logs — a support call about a
// product that was working yesterday. Pinned by a test for that reason.
//
export const ENTRA_PROVIDER_ID = 'entra'

/**
 * The claims we carry off the id_token.
 *
 * ⛔ THE OID IS THE IDENTITY AND THE EMAIL IS NOT. An `oid` is immutable; a UPN
 * is an attribute a tenant administrator can change, so keying an account on it
 * would make "who this is" editable from outside this product. The email rides
 * along because `users.email` is NOT NULL and every satellite displays it —
 * `lib/directoryUser.ts` treats it as a display value, never a join key.
 *
 * ⛔ THE GROUP CLAIM IS CARRIED WHOLE, pointer included. `_claim_names` /
 * `_claim_sources` is Entra saying "too many groups to list" (see the overage
 * note in lib/directoryRoles.ts); flattening the claims to a group array here
 * would throw that distinction away and a user in 201 groups would read as a
 * user in none.
 */
export type EntraClaims = GroupClaims & {
  oid?: string | null
  email?: string | null
  name?: string | null
}

/**
 * The directory side of sign-in, as an injectable bundle.
 *
 * ⛔ A TEST SEAM, NOT A CONFIGURATION POINT. The callbacks below run inside
 * NextAuth, which fixes their signatures, so there is nowhere to pass a fake
 * store — and a sign-in path nothing can test is how SecVault shipped a refusal
 * that did not refuse. Nothing in the app imports or writes this; the defaults
 * are the real `lib/directoryStore.ts` functions.
 */
export const directoryDeps = {
  loadMappings: loadDirectoryMappings,
  loadContext: loadDirectoryContext,
  createUser: createDirectoryUser,
  refreshRole: refreshDirectoryUserRole,
  userApps: getUserApps,
}
export type DirectoryDeps = typeof directoryDeps

/**
 * Build the Entra provider list for a given environment.
 *
 * ⛔ REGISTERED ONLY WHEN ALL THREE `ENTRA_*` KEYS ARE SET, AND THAT DIFFERS
 * FROM THE CREDENTIALS PROVIDER ABOVE IT ON PURPOSE. A credentials provider
 * that is not configured simply never authenticates anybody, which is
 * invisible. Entra is OAUTH: registering it unconfigured renders a "Sign in
 * with Microsoft" button that CANNOT complete a sign-in, and an operator who
 * meets a button that fails concludes the product is broken rather than that
 * they have not finished configuring it. Absent is the honest state.
 *
 * ⛔ IT CAN NEVER AFFECT LOCAL SIGN-IN. This is appended to the END of the
 * provider array; the credentials provider is unconditional and untouched. On a
 * segmented or air-gapped install `login.microsoftonline.com` being unreachable
 * is the NORMAL state, not a fault — an internet outage must never lock an
 * administrator out of the console that manages their network.
 *
 * ⛔ PURE, AND TAKES `env` RATHER THAN READING `process.env`. The provider array
 * is built once at module load, so a test could otherwise only ever observe
 * whichever state the test process happened to start in.
 */
export function entraProviders(env: Record<string, string | undefined>): any[] {
  if (!isEntraConfigured(env)) return []
  return [
    AzureADProvider({
      id: ENTRA_PROVIDER_ID,
      name: 'Microsoft Entra ID',
      clientId: String(env.ENTRA_CLIENT_ID),
      clientSecret: String(env.ENTRA_CLIENT_SECRET),
      tenantId: String(env.ENTRA_TENANT_ID),
      // The group claim rides the ID TOKEN, so `profile()` is where it can be
      // read. No Graph scope is requested: following the overage pointer would
      // need GroupMember.Read.All, which the setup instructions ask the tenant
      // administrator NOT to grant, plus a second outbound dependency on the
      // login path.
      authorization: { params: { scope: 'openid profile email' } },
      profile(profile: any) {
        const email = profile.email || profile.preferred_username || null
        return {
          // ⛔ The Entra object id, NOT the email — see EntraClaims above.
          // `signIn()` overwrites this with the hub's own `users.id` once the
          // account is provisioned, because the satellites resolve identity by
          // selecting that id out of the hub's table.
          id: profile.oid || profile.sub,
          name: profile.name || profile.preferred_username || email || null,
          email,
          // Resolved by signIn() from the group mapping; never from the token.
          role: null,
          entraClaims: {
            oid: profile.oid || null,
            email,
            name: profile.name || null,
            groups: profile.groups,
            _claim_names: profile._claim_names,
            _claim_sources: profile._claim_sources,
          } as EntraClaims,
        }
      },
    }),
  ]
}

/**
 * What a directory sign-in is allowed to become.
 *
 * ⛔ THE REFUSAL CARRIES ITS CAUSE FOR THE SERVER LOG ONLY. `cause` names the
 * outcome — `no_matching_group`, `groups_overage`, `mappings_unreadable`,
 * `email_collision` — each of which needs a different ADMINISTRATOR fix, and
 * each of which describes how this customer's directory is wired. The sign-in
 * page is reachable without authentication, so none of it may travel there.
 */
export type DirectoryAdmission =
  | { ok: true; id: number; role: Role; email: string; name: string; apps: string[] }
  | { ok: false; cause: string }

/**
 * ⛔ `isDirectoryRolePermitted`, NOT `again.role || null`.
 *
 * A refused re-resolution must CLEAR the role, never keep whatever the token
 * already carried. `|| null` happens to behave the same way today only because
 * `resolveDirectoryRole` nulls `role` on every refusal — this reads the OUTCOME,
 * so it stays correct if that ever stops being true. A truthiness test on a
 * privilege is the exact shape `isDirectoryRolePermitted` exists to prevent.
 */
export function tokenRoleFrom(d: Pick<RoleDecision, 'outcome' | 'role'>): Role | null {
  return isDirectoryRolePermitted(d) ? d.role : null
}

/**
 * Resolve the role, decide the account, and provision or refresh it.
 *
 * ⛔ THE ROLE IS RESOLVED FROM THE MAPPINGS, AND A FAILED MAPPING LOAD IS
 * PASSED ON AS `null` RATHER THAN `[]`. An empty array is the INSTRUCTION
 * "nothing is mapped, so refuse everyone" — a correct, deliberate, fail-closed
 * state — and a database blip must not be able to impersonate it, because the
 * administrator would then be told to fix a configuration that is fine.
 * `loadDirectoryMappings` throws for exactly this reason; `null` becomes
 * OUTCOME.MAPPINGS_UNREADABLE, which says plainly that the fault is ours.
 */
export async function admitDirectoryUser(
  claims: EntraClaims | null | undefined,
  deps: DirectoryDeps = directoryDeps,
): Promise<DirectoryAdmission> {
  let mappings: Awaited<ReturnType<DirectoryDeps['loadMappings']>> | null = null
  try {
    mappings = await deps.loadMappings()
  } catch {
    mappings = null
  }

  const roleDecision = resolveDirectoryRole(claims, mappings)
  if (!isDirectoryRolePermitted(roleDecision)) {
    return { ok: false, cause: `${roleDecision.outcome}: ${roleDecision.reason}` }
  }

  const oid = typeof claims?.oid === 'string' ? claims.oid.trim() : ''
  const email = typeof claims?.email === 'string' ? claims.email.trim() : ''

  // No oid means there is nothing to look a row up BY, and `decideDirectoryUser`
  // refuses on exactly that with its own stated cause. Querying for the empty
  // string first would be a round trip whose answer is already known.
  let rows: Awaited<ReturnType<DirectoryDeps['loadContext']>> | {} = {}
  if (oid) {
    try {
      rows = await deps.loadContext(oid, email)
    } catch {
      // ⛔ A FAILED LOOKUP IS NOT "NO ROW". `null` here would read as "provision
      // a new account" and create a duplicate for somebody who already has one,
      // orphaning their app access and site assignments on the old row.
      return {
        ok: false,
        cause:
          'directory_context_unreadable: the hub could not read its own users table, so this ' +
          'sign-in could not be matched to an account. The fault is in the hub or its database.',
      }
    }
  }

  const decision = decideDirectoryUser(claims, roleDecision.role, rows)
  if (!isDirectoryPermitted(decision)) {
    return { ok: false, cause: `${decision.outcome}: ${decision.reason}` }
  }

  const role = roleDecision.role as Role
  let id: number
  let rowEmail: string
  let rowName: string
  try {
    if (decision.create) {
      const created = await deps.createUser(decision.create)
      id = created.id
      rowEmail = created.email
      rowName = created.name
    } else {
      const match = decision.match!
      // ⛔ THE MAPPING IS AUTHORITATIVE ON EVERY SIGN-IN, NOT ONLY THE FIRST.
      // A role left on the row would keep working after the mapping that
      // granted it was removed.
      await deps.refreshRole(match.id, match.role)
      const byOid = (rows as { byOid?: { email: string; name: string } }).byOid
      id = match.id
      rowEmail = byOid?.email || email
      rowName = byOid?.name || email.split('@')[0]
    }
  } catch {
    // ⛔ FAIL CLOSED, AND DO NOT LET THIS THROW PAST signIn(). NextAuth puts a
    // thrown error's MESSAGE into the redirect URL
    // (core/routes/callback.js: `/error?error=${encodeURIComponent(message)}`),
    // so a database error escaping here would publish its text to an
    // unauthenticated page.
    return {
      ok: false,
      cause:
        'provisioning_failed: the hub account for this directory identity could not be created ' +
        'or updated. The fault is in the hub or its database.',
    }
  }

  // ⛔ THE SAME SOURCE OF TRUTH FOR `apps` A LOCAL SIGN-IN USES. `getUserApps`
  // feeds `session.user.apps`, which is what the three SSO handoff routes carry
  // into LogVault / DDIVault / SpanVault — a directory account resolved any
  // other way would reach a different set of apps than the hub's own user
  // administration says it may. It fails CLOSED to `[]` on a database error by
  // its own contract (lib/appAccess.ts), and netvault itself is always allowed.
  const apps = await deps.userApps(id, role)

  return { ok: true, id, role, email: rowEmail, name: rowName, apps }
}

/**
 * Re-resolve a directory token's role against the CURRENT mappings.
 *
 * ⛔ EVERY TOKEN USE, NOT ONLY SIGN-IN — the same treatment a local user's role
 * already gets below. A mapping an administrator revokes must stop working at
 * once, not at the end of the JWT's life.
 *
 * ⛔ IT RE-READS THE MAPPINGS, NEVER THE DIRECTORY, and the consequence is
 * stated rather than hidden: a MAPPING change applies immediately; a change to
 * someone's GROUP MEMBERSHIP in Entra applies at their next sign-in. A Graph or
 * LDAP round trip on the authorization path of every request is not acceptable
 * in this product.
 *
 * ⛔ FAILS CLOSED. Any throw — an unreadable mapping table, anything unforeseen
 * — yields `null`, never the role the token arrived with. Keeping the old role
 * on error would make a database blip extend a revoked privilege.
 */
export async function reresolveDirectoryRole(
  claims: EntraClaims | null | undefined,
  deps: DirectoryDeps = directoryDeps,
): Promise<Role | null> {
  try {
    const mappings = await deps.loadMappings()
    return tokenRoleFrom(resolveDirectoryRole(claims, mappings))
  } catch {
    return null
  }
}

/** The server-log line for a refusal. ⛔ NEVER a response body, never a URL. */
export function directoryRefusalLog(who: string, cause: string): string {
  return `[entra] sign-in REFUSED: ${who} — ${cause}`
}

const authOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        totp: { label: 'Authentication code', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null
        const res = await query('SELECT * FROM users WHERE email = $1', [credentials.email])
        const user = res.rows[0]
        if (!user) return null
        // ⛔ bcryptjs THROWS rather than returning false on a null hash
        // (measured: `Illegal arguments: string, object`), and
        // `users.password_hash` is NULLABLE — a directory account has none, by
        // design, because inventing one would create a credential nobody holds.
        // Without this guard a directory user typing a password into the hub's
        // form gets an exception and an opaque error instead of a failed login.
        //
        // ⛔ IT RETURNS THE SAME GENERIC `null` A WRONG PASSWORD RETURNS. Any
        // distinguishable answer here — a different error, a different timing
        // story, a message — turns the form into an oracle for WHICH addresses
        // are directory-backed, which is a map of the customer's directory
        // handed to an unauthenticated visitor.
        if (!canUsePassword(user)) return null
        const valid = await bcrypt.compare(credentials.password, user.password_hash)
        if (!valid) return null

        // ── Second factor ────────────────────────────────────────────────
        // This runs AFTER the password check and is authoritative. The login
        // page's /api/auth/mfa/precheck call is a UX affordance only — it tells
        // the form whether to show the code field. Nothing it returns is trusted
        // here; a client that skips it still lands on this check.
        if (user.mfa_enabled) {
          const gate = await verifySecondFactor(user, String(credentials.totp || ''))
          if (!gate.ok) return null
        } else if (mfaPolicyApplies(user) && (await mfaRequiredForRole(user.role))) {
          // Policy says this role must have MFA and this account has not
          // enrolled. Refuse rather than wave them through — otherwise turning
          // the policy on protects only the users who had already opted in,
          // which is the opposite of what enabling it is meant to do.
          // /login surfaces the reason via precheck so this isn't a silent
          // "wrong password".
          //
          // ⛔ EXCEPT FOR A DIRECTORY ACCOUNT, WHICH `mfaPolicyApplies` EXCLUDES.
          // It has no local TOTP secret and cannot enrol one, so without the
          // exemption the day somebody adds `super_admin` to
          // `app_settings.mfa_required_roles` every directory super_admin stops
          // being able to sign in, with the form reporting nothing more
          // specific than a failure. Their second factor belongs in Conditional
          // Access, in the directory that owns the identity.
          //
          // Such an account cannot normally reach this line at all —
          // `canUsePassword` above already turned it away — so this is the
          // second of two layers, and it is the layer that states the POLICY
          // rather than the mechanism. One function answers "does the hub's MFA
          // policy apply to this row" for every caller, so the two paths cannot
          // drift apart.
          return null
        }
        // Load assigned sites for site_admin
        let siteIds: number[] = []
        if (user.role === 'site_admin') {
          const sitesRes = await query('SELECT site_id FROM user_sites WHERE user_id = $1', [user.id])
          siteIds = sitesRes.rows.map((r: any) => r.site_id)
        }
        // Start the trial clock on the very first successful login
        try {
          const idRes = await query(
            "SELECT value FROM app_settings WHERE key = 'install_date'"
          )
          if (!idRes.rows[0]?.value) {
            await query(
              "INSERT INTO app_settings (key, value) VALUES ('install_date', $1) ON CONFLICT (key) DO UPDATE SET value = $1 WHERE app_settings.value = ''",
              [new Date().toISOString().split('T')[0]]
            )
          }
        } catch {}

        const apps = await getUserApps(user.id, user.role)

        return { id: String(user.id), name: user.name, email: user.email, role: user.role, siteIds, apps }
      }
    }),
    ...entraProviders(process.env as Record<string, string | undefined>),
  ],
  callbacks: {
    // ⛔ THE FRONT DOOR. WITHOUT THIS CALLBACK A REFUSED DIRECTORY SIGN-IN IS
    // NOT REFUSED — IT IS COMPUTED, LOGGED, AND THEN COMPLETED.
    //
    // `pages.signIn` below is a PAGE PATH, not a callback, and NextAuth's
    // DEFAULT `signIn` callback returns `true`. SecVault shipped exactly that:
    // its jwt() branch resolved a refusal, printed "sign-in REFUSED", wrote an
    // audit row — and handed out the session anyway. Two real users took that
    // path in its production logs.
    //
    // The credentials provider needs no equivalent: `authorize()` returning
    // null already is a failed sign-in. OAuth has no such lever — the provider
    // has ALREADY authenticated the person, and whether this hub accepts them is
    // this callback's only chance to say.
    async signIn({ user, account }: any) {
      if (!account || account.provider !== ENTRA_PROVIDER_ID) return true

      const who = (user && (user.email || user.name)) || 'unknown'
      let admission: DirectoryAdmission
      try {
        admission = await admitDirectoryUser(user?.entraClaims as EntraClaims | undefined)
      } catch (err: any) {
        // ⛔ NOTHING MAY THROW OUT OF HERE. NextAuth turns a throw into
        // `/api/auth/error?error=<error.message>` — i.e. it would publish the
        // exception text on an unauthenticated page, which is the one place the
        // cause must never appear.
        admission = { ok: false, cause: `unexpected_error: ${err?.message || 'unknown'}` }
      }

      if (!admission.ok) {
        // ⛔ THE REFUSAL IS SPLIT IN TWO, DELIBERATELY.
        //
        // The NAMED CAUSE GOES HERE AND NOWHERE ELSE. `no_matching_group`,
        // `groups_unreadable`, `groups_overage`, `mappings_unreadable`,
        // `email_collision` and `role_unsupported` need six different
        // administrator fixes, and each one describes how this customer's
        // directory is wired — which group grants what, whether a collision
        // exists with a named local account, whether the hub's own database is
        // down. The sign-in page is reachable WITHOUT AUTHENTICATION, so none
        // of that may be put in the redirect URL or in any response body. Same
        // rule the login form already follows for MFA: one message to the user,
        // the specific reason to the log.
        console.warn(directoryRefusalLog(who, admission.cause))

        // ⛔ THE SAME FACTS, BEHIND super_admin — NOT A SECOND CHANNEL TO THE
        // USER. The split above keeps the cause off the login page; it also
        // left the ADMINISTRATOR with nothing, because the log line goes to a
        // Windows service file nobody reads and the group ids this person
        // presented went nowhere at all. Those ids are precisely what has to be
        // typed into the mapping table, so recording them turns "ask an
        // administrator" into something the administrator can act on.
        //
        // ⛔ AWAITED, BUT IT CANNOT THROW AND CANNOT REFUSE. recordDirectoryRefusal
        // swallows and logs every failure of its own: a throw escaping here
        // becomes /api/auth/error?error=<message>, publishing the exception text
        // on an unauthenticated page. The refusal below is unaffected either way.
        const claims = user?.entraClaims as GroupClaims | undefined
        const presented = groupsFromClaims(claims)
        await recordDirectoryRefusal({
          email: typeof (claims as any)?.email === 'string' ? (claims as any).email : null,
          entraOid: typeof (claims as any)?.oid === 'string' ? (claims as any).oid : null,
          cause: admission.cause,
          // `null` on an overage is not "no groups": Microsoft replaced the
          // list with a link, so there is genuinely nothing to record, and the
          // cause already says so.
          groupKeys: presented.groups,
        })

        // ⛔ `false` IS THE REFUSAL, and it is the ONLY thing that travels.
        // NextAuth answers a falsy return with `/api/auth/error?error=
        // AccessDenied`, and `pages.error` below sends that on to /login — so
        // the user lands on the sign-in page with NextAuth's own generic token
        // and not one word about why. A string return would be a redirect of
        // our own choosing, and the temptation to put the cause in it is
        // exactly what this split exists to remove.
        //
        // ⛔ NO SESSION COOKIE IS ISSUED ON THIS PATH: NextAuth returns before
        // its callback handler runs, so there is no token for jwt() to
        // decorate and nothing for any route to admit.
        return false
      }

      // ⛔ THE HUB'S OWN `users.id` REPLACES THE OID ON THE USER OBJECT, and
      // this is load-bearing rather than tidy-up. NextAuth hands this very
      // object to jwt() next (no adapter is configured, so
      // core/lib/callback-handler.js returns the profile unchanged), and the
      // three satellites resolve identity from the hub's table: LogVault does
      // `SELECT ... FROM users WHERE id = $1` and DDIVault asks the hub's
      // /api/auth/sso-verify, both of which fail outright on an oid. SpanVault
      // is worse: it falls through to `payload.role || 'viewer'` and would
      // silently demote a directory super_admin instead of failing.
      user.id = String(admission.id)
      user.role = admission.role
      user.email = admission.email
      user.name = admission.name
      user.apps = admission.apps
      // ⛔ EMPTY, AND IT CANNOT BE ANYTHING ELSE. `site_admin` is refused
      // upstream for a directory account (lib/directoryUser.ts:
      // DIRECTORY_PROVISIONABLE_ROLES) precisely because its scope comes from
      // `user_sites`, which a provisioned row has none of — so there is no
      // directory account for which a non-empty list would be meaningful.
      user.siteIds = []

      console.log(`[entra] sign-in: ${who} -> ${admission.role} (hub user ${admission.id})`)
      return true
    },
    async jwt({ token, user, account }: any) {
      if (user) {
        token.role = user.role
        token.id = user.id
        token.siteIds = user.siteIds || []
        token.apps = user.apps || []
        // Which provider minted this token. ⛔ Read on EVERY later call, so it
        // has to be on the token rather than inferred from its contents: an
        // older token (issued before this feature) carries no provider and
        // must stay on the local path, not fall into the directory branch.
        if (account?.provider) token.provider = account.provider
        // ⛔ The group claims are carried WHOLE so the re-resolution below can
        // run without re-reading the directory. The JWT is encrypted (JWE,
        // A256GCM) so this is not readable by the browser, and the app
        // registration is configured to emit only groups ASSIGNED TO THE
        // APPLICATION, which is what keeps the claim — and this cookie — small.
        if (user.entraClaims !== undefined) token.entraClaims = user.entraClaims
      }

      // ⛔ THIS IS THE LAYER THAT CATCHES A MID-SESSION REVOCATION, and signIn()
      // above cannot: by then the front door has already been passed. Local
      // users have had the equivalent since RBAC shipped (their role is
      // re-read from `users` on every token use elsewhere in this suite); a
      // directory user exempted from it would hold a mapping an administrator
      // removed for the whole life of the JWT.
      if (token.provider === ENTRA_PROVIDER_ID) {
        token.role = await reresolveDirectoryRole(token.entraClaims as EntraClaims | undefined)

        // ⛔ NOTHING IS LOGGED OR AUDITED HERE, with one exception. This
        // callback runs on every request, so an unconditional write of either
        // kind would print every page load. The exception is a DISAGREEMENT
        // DETECTOR: if `user` is set we are on the first call after a sign-in
        // signIn() just PERMITTED, so a refusal here means the two decisions
        // disagreed within milliseconds — a mapping changed mid-flight, or the
        // two are no longer asking the same question. Silence would make that
        // invisible.
        if (user && !token.role) {
          console.warn(
            '[entra] signIn permitted this sign-in and the token re-resolution refused it. ' +
              'The session carries no role and will be denied.',
          )
        }
      }
      return token
    },
    async session({ session, token }: any) {
      if (session.user) { session.user.role = token.role; session.user.id = token.id; session.user.siteIds = token.siteIds || []; session.user.apps = token.apps || [] }
      return session
    }
  },
  // ⛔ `error` IS SET SO A REFUSAL LANDS ON THE SIGN-IN PAGE. Without it a
  // `false` from signIn() above stops at NextAuth's built-in error page, which
  // is a bare framework screen on a product the operator paid for. With it,
  // NextAuth redirects `/api/auth/error?error=AccessDenied` on to
  // `/login?error=AccessDenied` (core/index.js, the "error" action) — the
  // sign-in page, carrying NextAuth's own generic token and nothing about the
  // cause.
  pages: { signIn: '/login', error: '/login' },
  session: { strategy: 'jwt' as const },
  secret: process.env.NEXTAUTH_SECRET,
}

const handler = NextAuth(authOptions)
export { handler as GET, handler as POST, authOptions }
