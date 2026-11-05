'use client'

import { useCallback, useEffect, useState } from 'react'
import { Callout, FieldLabel, Mono, PanelCard, PanelLoading, StatePill } from './panelChrome.tsx'

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

const ROLE_HELP: Record<string, string> = {
  super_admin: 'Everything, including these settings and the tenant itself.',
  admin: 'Day-to-day administration. Cannot change single sign-on.',
  viewer: 'Read-only.',
}

export function DirectoryMappingsCard({ ssoConfigured }: { ssoConfigured: boolean }) {
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

  useEffect(() => { void load() }, [load])

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
      {mappings && mappings.length === 0 && ssoConfigured && (
        <Callout tone="warn" title="Single sign-on is on, but no group is mapped">
          Every directory sign-in will be refused until a group is mapped below. People will reach
          Microsoft, authenticate successfully, and come back to the login page being told to ask an
          administrator — this is that configuration. Local accounts are unaffected.
        </Callout>
      )}
      {mappings && mappings.length === 0 && !ssoConfigured && (
        <Callout tone="neutral" title="No groups mapped">
          Nothing to do until single sign-on is configured above. Mappings set here take effect as
          soon as it is.
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
    </PanelCard>
  )
}
