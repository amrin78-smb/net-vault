'use client'
import { useState } from 'react'
import { Icon } from '@/components/system/icons'
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from '@/components/system/Menu'
import { Dialog } from '@/components/system/Dialog'

/**
 * Help menu.
 *
 * The header's Help button used to link to `/compliance` — a real page, but
 * an unrelated one, so "Help" silently took an operator to the compliance
 * report. There is no documentation site to point at, and inventing a
 * `/docs` route would just move the dead end, so this offers what is
 * genuinely available: the keyboard shortcuts this app actually binds, the
 * version it is actually running, and the instruction to contact the local
 * administrator (who, for an on-premise install, is the support channel).
 */
export default function HelpMenu({ version }: { version?: string | null }) {
  const [showKeys, setShowKeys] = useState(false)

  const shortcuts: { keys: string; what: string }[] = [
    { keys: 'Ctrl K  /  ⌘K', what: 'Focus search' },
    { keys: '/',                  what: 'Focus search' },
    { keys: '↑ ↓',      what: 'Move through search results' },
    { keys: 'Enter',              what: 'Open the highlighted result' },
    { keys: 'Esc',                what: 'Close search, a menu or a dialog' },
    { keys: 'Tab',                what: 'Move to the next control' },
  ]

  return (
    <>
      <DropdownMenu
        label="Help"
        trigger={({ toggle, open, ref }) => (
          <button ref={ref} type="button" className="icon-btn help-trigger" onClick={toggle}
            aria-label="Help" aria-haspopup="menu" aria-expanded={open}>
            <Icon.help size={19} />
          </button>
        )}
      >
        <MenuLabel>Help</MenuLabel>
        <MenuItem icon={<Icon.key size={15} />} onSelect={() => setShowKeys(true)}>
          Keyboard shortcuts
        </MenuItem>
        <MenuItem icon={<Icon.shield size={15} />} href="/settings?tab=security">
          Security &amp; two-factor
        </MenuItem>
        <MenuItem icon={<Icon.info size={15} />} href="/settings?tab=about">
          About &amp; system info
        </MenuItem>
        <MenuSeparator />
        <div style={{ padding: '6px 10px 4px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Need help with your account or data? Contact your NocVault
          administrator.
          {version && <div style={{ marginTop: 4 }}>NetVault v{version}</div>}
        </div>
      </DropdownMenu>

      <Dialog
        open={showKeys}
        onClose={() => setShowKeys(false)}
        title="Keyboard shortcuts"
        description="Shortcuts available throughout NetVault."
        footer={<button className="btn" onClick={() => setShowKeys(false)}>Close</button>}
      >
        <dl className="dl" style={{ marginTop: 14, gridTemplateColumns: '150px 1fr' }}>
          {shortcuts.map(s => (
            <div key={s.keys + s.what} style={{ display: 'contents' }}>
              <dt><kbd className="kbd">{s.keys}</kbd></dt>
              <dd>{s.what}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </>
  )
}
