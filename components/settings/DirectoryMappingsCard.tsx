'use client'

import { useCallback, useEffect, useState } from 'react'
import { Callout, FieldLabel, Mono, PanelCard, PanelLoading, StatePill } from './panelChrome.tsx'

// ⛔ THE CAP COMES FROM THE API, NOT FROM AN IMPORT. `DIRECTORY_REFUSAL_KEEP`
// lives in lib/directoryRefusals.ts, which imports ./db.ts — importing it from
// a 'use client' component drags the entire `pg` driver into the BROWSER bundle
// and the Turbopack build fails on node-only built-ins. Measured: 6 errors from
// pg/lib/connection-parameters.js and pg-connection-string. Any constant a
// client component needs from a server module has to travel as data.

// Settings → Single sign-on → the group -> role table.
//
// This is the half of directory sign-in that decides WHAT someone becomes. The
// other half (tenant, client id, secret) decides WHICH DIRECTORY is trusted. It
// is a separate card because the two fail in different ways and an administrator
// reads them at different times: the tenant is set once, and the mappings are
// edited whenever the customer reorganises their groups.
//
// ⛔ AN EMPTY TABLE REFUSES EVERY DIRECTORY SIGN-IN, AND THAT IS THE SHIPPING
// STATE. lib/directoryRoles.ts returns OUTCOME.NO_MAPPINGS for zero rows. So the
// most important thing this card does is SAY SO while single sign-on is
// configured and the list is empty — otherwise the first experience of the
// feature is a correctly-configured tenant, a working Microsoft sign-in, and a
// blanket refusal with nothing on screen explaining it.
//
// ⛔ AND IT MUST NOT OFFER A DEFAULT. "Map all directory users to viewer" would
// grant a role to every member of a directory this product does not administer.
// The refusal is the safe state; the fix is one deliberate mapping.

type Mapping = {
  id: number
  groupKey: string
  displayName: string | null
  role: string
  createdAt: string
}

type Refusal = {
  id: string
  occurredAt: string
  email: string | null
  entraOid: string | null
  explanation: { code: string; title: string; fix: string; action: string }
  groupKeys: string[]
}

const ROLE_HELP: Record<string, string> = {
  super_admin: 'Everything, including these settings and the tenant itself.',
  admin: 'Day-to-day administration. Cannot change single sign-on.',
  viewer: 'Read-only.',
}

// `ssoConfigured` is TRI-STATE. `null` means the caller could not read the Entra
// settings (that route reads env files and can 500 while the database is
// perfectly healthy), so this card states the consequence of an empty list
// without asserting whether single sign-on is on.
export function DirectoryMappingsCard({ ssoConfigured }: { ssoConfigured: boolean | null }) {
  const [loading, setLoading] = useState(true)
  const [mappings, setMappings] = useState<Mapping[] | null>(null)
  const [roles, setRoles] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [groupKey, setGroupKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formDetail, setFormDetail] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)

  // ⛔ FETCHED SEPARATELY FROM THE MAPPINGS, ON PURPOSE. These are the
  // diagnostic FOR the mapping table, so they belong in the same card — but one
  // read failing must not hide the other, and the whole reason this section
  // exists is that a fault in one place was leaving an administrator with
  // nothing to go on.
  const [refusals, setRefusals] = useState<Refusal[] | null>(null)
  const [refusalError, setRefusalError] = useState<string | null>(null)
  const [refusalKeep, setRefusalKeep] = useState(50)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/system/directory-mappings', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // ⛔ A FAILED READ IS NOT AN EMPTY LIST. Rendering the empty-table
        // warning for a database fault would tell an administrator their
        // mappings are missing when they are not, and the obvious next move
        // (adding them again) lands on the duplicate path.
        setMappings(null)
        setLoadError(data?.error || 'Could not read the group mappings.')
        return
      }
      setMappings(Array.isArray(data.mappings) ? data.mappings : [])
      setRoles(Array.isArray(data.roles) ? data.roles : [])
      setLoadError(null)
    } catch {
      setMappings(null)
      setLoadError('Could not reach the server to read the group mappings.')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRefusals = useCallback(async () => {
    try {
      const res = await fetch('/api/system/directory-refusals', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRefusals(null)
        setRefusalError(data?.error || 'Could not read the refused sign-ins.')
        return
      }
      setRefusals(Array.isArray(data.refusals) ? data.refusals : [])
      if (Number.isFinite(data.keep)) setRefusalKeep(data.keep)
      setRefusalError(null)
    } catch {
      setRefusals(null)
      setRefusalError('Could not reach the server to read the refused sign-ins.')
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadRefusals() }, [loadRefusals])

  async function add() {
    setSaving(true)
    setFormError(null)
    setFormDetail(null)
    setNotice(null)
    try {
      const res = await fetch('/api/system/directory-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupKey: groupKey.trim(), displayName: displayName.trim(), role }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFormError(data?.error || 'Could not save the mapping.')
        setFormDetail(data?.detail || null)
        return
      }
      setGroupKey('')
      setDisplayName('')
      setRole('')
      setNotice('Mapping added. It applies to the next sign-in — nobody already signed in is affected until their session is renewed.')
      await load()
      await loadRefusals()
    } catch {
      setFormError('Could not reach the server.')
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: number) {
    setSaving(true)
    setFormError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/system/directory-mappings?id=${encodeURIComponent(String(id))}`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFormError(data?.error || 'Could not remove the mapping.')
        return
      }
      setConfirmingId(null)
      // The API tells us whether that was the last one, because an
      // administrator tidying a list has no reason to know the table going
      // empty locks the whole directory out.
      setNotice(
        data?.lockedOut
          ? 'That was the last mapping. No directory account can sign in now — add a mapping to restore access. Local accounts are unaffected.'
          : 'Mapping removed. Anyone who held a role only through that group loses it at their next sign-in.',
      )
      await load()
    } catch {
      setFormError('Could not reach the server.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <PanelLoading />

  const canAdd = groupKey.trim().length > 0 && role.length > 0 && !saving

  return (
    <PanelCard
      title="Directory group to role mappings"
      description={
        <>Which Entra group gives which role here. A directory account is provisioned on its first
        sign-in with the role its groups earn — and nothing else: a person in no mapped group is
        refused, which is why this list is the thing to check first when single sign-on is
        rejecting people. Someone in more than one mapped group gets the most privileged of them.</>
      }
    >
      {loadError && (
        <Callout tone="danger" title="The mappings could not be read">
          {loadError}
          <div style={{ marginTop: 6, fontSize: 'var(--text-sm)' }}>
            This is a fault on our side, not a configuration problem — your existing mappings are
            unaffected and directory sign-in keeps using them.
            <button
              className="btn-secondary"
              style={{ padding: '4px 12px', marginLeft: 10 }}
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        </Callout>
      )}

      {/* ⛔ THE ONE WARNING THIS CARD EXISTS FOR. */}
      {mappings && mappings.length === 0 && ssoConfigured === true && (
        <Callout tone="warn" title="Single sign-on is on, but no group is mapped">
          Every directory sign-in will be refused until a group is mapped below. People will reach
          Microsoft, authenticate successfully, and come back to the login page being told to ask an
          administrator — this is that configuration. Local accounts are unaffected.
        </Callout>
      )}
      {mappings && mappings.length === 0 && ssoConfigured === false && (
        <Callout tone="neutral" title="No groups mapped">
          Nothing to do until single sign-on is configured above. Mappings set here take effect as
          soon as it is.
        </Callout>
      )}
      {mappings && mappings.length === 0 && ssoConfigured === null && (
        <Callout tone="warn" title="No groups mapped">
          While this list is empty every directory sign-in is refused. Whether single sign-on is
          currently configured could not be read — that is a separate setting and a separate fault,
          and it does not affect the mappings below. Local accounts are unaffected either way.
        </Callout>
      )}

      {mappings && mappings.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 18 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
            <thead>
              <tr>
                {['Group', 'Group object ID', 'Role', ''].map((h, i) => (
                  <th
                    key={h + i}
                    style={{
                      textAlign: 'left', padding: '8px 10px', fontSize: 'var(--text-xs)',
                      textTransform: 'uppercase', letterSpacing: '0.04em',
                      color: 'var(--text-muted)', borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mappings.map(m => (
                <tr key={m.id}>
                  <td style={{ padding: '10px', borderBottom: '1px solid var(--border-light)' }}>
                    {/* The display name is a LABEL ONLY — it is not what gets
                        matched, and it is not kept in step with Entra. Saying so
                        here stops it being read as the thing that decides. */}
                    {m.displayName
                      ? m.displayName
                      : <span style={{ color: 'var(--text-muted)' }}>Unnamed</span>}
                  </td>
                  <td style={{ padding: '10px', borderBottom: '1px solid var(--border-light)' }}>
                    <Mono>{m.groupKey}</Mono>
                  </td>
                  <td style={{ padding: '10px', borderBottom: '1px solid var(--border-light)' }}>
                    <StatePill tone={m.role === 'super_admin' ? 'warn' : 'neutral'}>{m.role}</StatePill>
                  </td>
                  <td style={{ padding: '10px', borderBottom: '1px solid var(--border-light)', textAlign: 'right' }}>
                    {confirmingId === m.id ? (
                      <>
                        <button
                          className="btn-danger"
                          style={{ padding: '4px 12px', marginRight: 6 }}
                          disabled={saving}
                          onClick={() => void remove(m.id)}
                        >
                          {saving ? 'Removing…' : (mappings.length === 1 ? 'Remove the last one' : 'Remove')}
                        </button>
                        <button
                          className="btn-secondary"
                          style={{ padding: '4px 12px' }}
                          disabled={saving}
                          onClick={() => setConfirmingId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn-secondary"
                        style={{ padding: '4px 12px' }}
                        disabled={saving}
                        onClick={() => { setConfirmingId(m.id); setFormError(null); setNotice(null) }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ⛔ ENTRA DOES NOT EMIT A GROUPS CLAIM BY DEFAULT, AND NOTHING ELSE IN
          THIS PRODUCT SAYS SO. Without one, lib/directoryRoles.ts returns
          GROUPS_UNREADABLE and refuses everybody — which looks from the login
          page EXACTLY like "no group is mapped", so an administrator who has
          just filled this table in correctly sees no change and has no reason
          to suspect the app registration. The two causes are distinguished in
          the server log; this note is what stops someone needing to find it. */}
      <div style={{ marginBottom: 18 }}>
        <Callout tone="info" title="The app registration must be set to send group memberships">
          A mapping only works if the sign-in token actually carries the person’s groups, and Entra
          does not include them unless asked. In the app registration, under Token configuration,
          add a <strong>groups claim</strong> for the ID token.
          <div style={{ marginTop: 6, fontSize: 'var(--text-sm)' }}>
            Choose <em>Groups assigned to the application</em> rather than all groups. A person in
            very many groups otherwise gets a token that lists none of them — Microsoft replaces the
            list with a link — and NocVault refuses that sign-in rather than treating the person as
            having no groups.
          </div>
        </Callout>
      </div>

      <FieldLabel
        hint="The group's object ID (a GUID) from Entra — Groups → the group → Overview. It is the value Microsoft puts in the token, and the only thing matched on. Case does not matter."
      >
        Group object ID
      </FieldLabel>
      <input
        value={groupKey}
        onChange={e => setGroupKey(e.target.value)}
        placeholder="00000000-0000-0000-0000-000000000000"
        spellCheck={false}
        style={{ width: '100%', marginBottom: 14, fontFamily: 'var(--font-mono)' }}
        disabled={saving}
      />

      <FieldLabel hint="Shown in the list above so this is readable. A label only — it is never matched, and it does not follow a rename in Entra.">
        Group name (optional)
      </FieldLabel>
      <input
        value={displayName}
        onChange={e => setDisplayName(e.target.value)}
        placeholder="Network Administrators"
        style={{ width: '100%', marginBottom: 14 }}
        disabled={saving}
      />

      <FieldLabel hint="site_admin is deliberately not offered: it is scoped to assigned sites, and an account provisioned from the directory has none — it would sign in able to see nothing.">
        Role this group grants
      </FieldLabel>
      <select
        value={role}
        onChange={e => setRole(e.target.value)}
        style={{ width: '100%', marginBottom: 6 }}
        disabled={saving}
      >
        <option value="">Choose a role…</option>
        {roles.map(r => <option key={r} value={r}>{r}</option>)}
      </select>
      {role && ROLE_HELP[role] && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 14 }}>
          {ROLE_HELP[role]}
        </div>
      )}
      {role === 'super_admin' && (
        <div style={{ marginBottom: 14 }}>
          <Callout tone="warn" title="This grants full control to everyone in that group">
            A super_admin can change the tenant above and these mappings, so anyone who can add
            members to that group in Entra can grant themselves full control of NocVault. Map it to
            a group whose membership is administered as carefully as this application is.
          </Callout>
        </div>
      )}

      {formError && (
        <div style={{ marginBottom: 14 }}>
          <Callout tone="danger" title="Not saved">
            {formError}
            {formDetail && <div style={{ marginTop: 6, fontSize: 'var(--text-sm)' }}>{formDetail}</div>}
          </Callout>
        </div>
      )}
      {notice && (
        <div style={{ marginBottom: 14 }}>
          <Callout tone="ok" title="Done">{notice}</Callout>
        </div>
      )}

      <button
        className="btn-primary"
        style={{ padding: '10px 20px' }}
        disabled={!canAdd}
        onClick={() => void add()}
      >
        {saving ? 'Saving…' : 'Add mapping'}
      </button>

      {/* ── Recent refused sign-ins ───────────────────────────────────────
          ⛔ THIS IS THE OTHER HALF OF A DELIBERATE SPLIT. The login page tells
          a refused person only to ask an administrator, because it is reachable
          without authenticating and the cause describes how the customer's
          directory is wired. That left the administrator with nothing too: the
          cause went to a Windows service log, and the group ids the person
          presented went nowhere. Three of the causes look identical from the
          login page and need three different fixes, so without this an
          administrator is guessing between "map a group", "change the app
          registration" and "our database was down". */}
      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: 4 }}>
          Recent refused sign-ins
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 14 }}>
          The last {refusalKeep} directory sign-ins NocVault turned away, and why. People
          are told only to ask an administrator, so this is the only place the reason appears.
        </div>

        {refusalError && (
          <Callout tone="danger" title="The refused sign-ins could not be read">
            {refusalError}
            <button
              className="btn-secondary"
              style={{ padding: '4px 12px', marginLeft: 10 }}
              onClick={() => void loadRefusals()}
            >
              Try again
            </button>
          </Callout>
        )}

        {refusals && refusals.length === 0 && !refusalError && (
          <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
            None recorded. Either nobody has been turned away, or single sign-on has not been used yet.
          </div>
        )}

        {refusals && refusals.length > 0 && refusals.map(r => (
          <div
            key={r.id}
            style={{
              border: '1px solid var(--border-light)', borderRadius: 'var(--radius)',
              padding: '12px 14px', marginBottom: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 'var(--text-md)' }}>
                {r.email || <span style={{ color: 'var(--text-muted)' }}>unknown account</span>}
              </strong>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                {new Date(r.occurredAt).toLocaleString()}
              </span>
            </div>
            <div style={{ marginTop: 6, fontSize: 'var(--text-base)' }}>{r.explanation.title}</div>
            <div style={{ marginTop: 2, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              {r.explanation.fix}
            </div>

            {/* The ids are the whole point: they are exactly what has to go in
                the field above, and retyping a GUID from a log is how a
                mapping ends up subtly wrong. */}
            {r.groupKeys.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 6 }}>
                  Groups this person presented
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {r.groupKeys.map(g => {
                    const already = (mappings || []).some(m => m.groupKey.toLowerCase() === g.toLowerCase())
                    return (
                      <button
                        key={g}
                        type="button"
                        className="btn-secondary"
                        disabled={already}
                        title={already ? 'Already mapped' : 'Put this group id in the field above'}
                        style={{ padding: '3px 10px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', opacity: already ? 0.5 : 1 }}
                        onClick={() => {
                          setGroupKey(g)
                          setFormError(null)
                          setNotice(null)
                        }}
                      >
                        {g}{already ? ' ✓' : ''}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </PanelCard>
  )
}
