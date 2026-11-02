'use client'
import { useEffect, useRef, useCallback, useId } from 'react'

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Modal dialog / drawer.
 *
 * Focus handling is the whole point of this component, so it is worth saying
 * what it does: on open it remembers whatever had focus, moves focus inside,
 * keeps Tab from escaping while open, and on close puts focus back where it
 * was. Without the restore step a keyboard user who closes a dialog is
 * returned to the top of the document and has to tab all the way back to the
 * row they were working on.
 *
 * `onClose` is called for Escape and for a backdrop click. Pass
 * `dismissible={false}` for a dialog in the middle of a destructive or
 * in-flight operation, where a stray click must not discard the work.
 */
export function Dialog({
  open, onClose, title, description, children, footer,
  variant = 'dialog', labelledBy, dismissible = true, initialFocus, maxWidth,
}: {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  children?: React.ReactNode
  footer?: React.ReactNode
  variant?: 'dialog' | 'drawer'
  labelledBy?: string
  dismissible?: boolean
  initialFocus?: React.RefObject<HTMLElement | null>
  maxWidth?: number | string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  // useId, not Math.random: a random id is computed during render (impure)
  // and differs between the server and client passes, which is a hydration
  // mismatch on the very attribute that names the dialog.
  const titleId = useId()

  const close = useCallback(() => { if (dismissible) onClose() }, [dismissible, onClose])

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null

    const panel = panelRef.current
    const target = initialFocus?.current
      || panel?.querySelector<HTMLElement>(FOCUSABLE)
      || panel
    // rAF: the panel has just mounted, and focusing before paint is ignored
    // by some browsers.
    const raf = requestAnimationFrame(() => target?.focus())

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return }
      if (e.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(el => el.offsetParent !== null || el === document.activeElement)
      if (items.length === 0) { e.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)

    // Lock background scroll; restore the exact prior value rather than
    // assuming it was ''.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = prevOverflow
      restoreRef.current?.focus?.()
    }
  }, [open, close, initialFocus])

  if (!open) return null

  return (
    <div
      className={'dialog-backdrop' + (variant === 'drawer' ? ' drawer-backdrop' : '')}
      onMouseDown={e => { if (e.target === e.currentTarget) close() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy || (title ? titleId : undefined)}
        tabIndex={-1}
        className={'dialog' + (variant === 'drawer' ? ' drawer' : '')}
        style={maxWidth ? { maxWidth } : undefined}
      >
        {title && (
          <div className="dialog-head">
            <h2 className="dialog-title" id={titleId}>{title}</h2>
          </div>
        )}
        <div className="dialog-body">
          {description && <p style={{ margin: title ? '6px 0 0' : 0 }}>{description}</p>}
          {children}
        </div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  )
}
