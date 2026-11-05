'use client'
//
// components/settings/panelChrome.tsx — the shared markup for the three system
// settings panels.
//
// ⛔ EVERY COMPONENT IN THIS FILE IS DECLARED AT MODULE TOP LEVEL, AND SO IS
// EVERY COMPONENT THAT USES THEM. CLAUDE.md lists this first among the critical
// rules: a component declared inside another is a NEW component type on every
// render, so React unmounts the old tree and mounts a new one — the input the
// operator is typing a tenant id or a PEM block into loses focus on every
// keystroke. These panels are almost entirely text inputs, so there is nowhere
// for that bug to hide and nowhere for it to be survivable.
//
// ⛔ NO TAILWIND AND NO HARDCODED HEX. The design system is `app/globals.css`
// custom properties plus inline `style={{}}`; a literal colour that duplicates
// a token does not flip in dark mode.

import { useState } from 'react'
import { toneStyle, type Tone } from './systemPanelHelpers.ts'

/** The card every section on the Settings page is drawn in. */
export function PanelCard({ title, description, children, maxWidth = 860 }: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  maxWidth?: number
}) {
  return (
    <div style={{
      background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '20px', maxWidth,
    }}>
      <div style={{
        fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-secondary)',
        marginBottom: description ? '6px' : '16px', textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>{title}</div>
      {description && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.6 }}>
          {description}
        </div>
      )}
      {children}
    </div>
  )
}

/**
 * A tinted callout.
 *
 * ⛔ THE TONE IS THE MESSAGE. `danger` is reserved for something that is broken
 * now; a question (the two confirmation prompts) is `warn`, not `danger`, and
 * `disabled`/not-configured is `neutral`, because it is not a fault.
 */
export function Callout({ tone, title, children, actions }: {
  tone: Tone
  title?: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
}) {
  const t = toneStyle(tone)
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      style={{
        background: t.background, color: t.color, border: `1px solid ${t.borderColor}`,
        borderRadius: 'var(--radius-sm)', padding: '12px 14px', marginBottom: '12px',
        fontSize: 'var(--text-base)', lineHeight: 1.6,
      }}
    >
      {title && <div style={{ fontWeight: 700, marginBottom: children ? 4 : 0 }}>{title}</div>}
      {children}
      {actions && <div style={{ display: 'flex', gap: '8px', marginTop: 12, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  )
}

/** A small tinted pill, same shape as the Users table's Directory badge. */
export function StatePill({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  const t = toneStyle(tone)
  return (
    <span
      title={title}
      style={{
        fontSize: 'var(--text-xs)', fontWeight: 600, padding: '2px 8px', borderRadius: 'var(--radius-pill)',
        background: t.background, color: t.color, whiteSpace: 'nowrap', display: 'inline-block',
      }}
    >{children}</span>
  )
}

/** A label/value row, the same table shape the About section uses. */
export function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--border-light)' }}>
      <td style={{ padding: '8px 0', color: 'var(--text-muted)', width: '180px', verticalAlign: 'top', fontSize: 'var(--text-base)' }}>
        {label}
      </td>
      <td style={{ padding: '8px 0', color: 'var(--text-primary)', fontSize: 'var(--text-base)', wordBreak: 'break-word' }}>
        {children}
      </td>
    </tr>
  )
}

export function FactTable({ children }: { children: React.ReactNode }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <tbody>{children}</tbody>
    </table>
  )
}

/** Monospaced value — paths, URLs, GUIDs, subjects. */
export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
      {children}
    </span>
  )
}

export function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <>
      <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>
        {children}
      </label>
      {hint && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '6px', lineHeight: 1.6 }}>{hint}</div>}
    </>
  )
}

/**
 * A read-only value with a copy button.
 *
 * ⛔ COPYABLE BECAUSE IT HAS TO MATCH BYTE FOR BYTE. The Redirect URI is
 * compared character by character by Microsoft; a value an operator retypes
 * from the screen is the commonest way this feature is mis-set up, and the
 * resulting failure never reaches this server's logs.
 */
export function CopyValue({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
      <div style={{
        flex: 1, minWidth: 0, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-subtle)', padding: '9px 12px', fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-sm)', color: 'var(--text-primary)', wordBreak: 'break-all',
      }}>{value}</div>
      <button
        type="button"
        className="btn-secondary"
        aria-label={label ? `Copy ${label}` : 'Copy'}
        style={{ padding: '8px 16px', whiteSpace: 'nowrap', flexShrink: 0 }}
        onClick={() => {
          try {
            void navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          } catch { /* a failed copy leaves the value on screen to select by hand */ }
        }}
      >{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

/**
 * A "saved" value beside the "running" one.
 *
 * ⛔ BOTH ARE SHOWN WHENEVER THEY DIFFER. The process read its environment at
 * startup; a value saved a moment ago is not the value in force, and one number
 * on screen cannot say which of the two it is.
 */
export function SavedRunningRows({ saved, running, differs, serviceName }: {
  saved: string | null
  running: string | null
  differs: boolean
  serviceName: string
}) {
  return (
    <>
      <FactRow label="Saved on disk">
        {saved ? <Mono>{saved}</Mono> : <span style={{ color: 'var(--text-muted)' }}>Not set</span>}
        {differs && <> <StatePill tone="warn" title={`Not in force until ${serviceName} restarts`}>Pending restart</StatePill></>}
      </FactRow>
      <FactRow label="Currently running">
        {running ? <Mono>{running}</Mono> : <span style={{ color: 'var(--text-muted)' }}>Not set</span>}
      </FactRow>
    </>
  )
}

/** The spinner-free loading line every panel uses while its GET is in flight. */
export function PanelLoading() {
  return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
}
