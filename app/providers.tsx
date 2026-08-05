'use client'
import { SessionProvider } from 'next-auth/react'
import { createContext, useContext, useState, useCallback, ReactNode } from 'react'

// ── Toast ──────────────────────────────────────────────────────
type ToastType = 'success' | 'error' | 'info'
type Toast = { id: number; message: string; type: ToastType }
type ToastCtx = { showToast: (message: string, type?: ToastType) => void }

const ToastContext = createContext<ToastCtx>({ showToast: () => {} })
export const useToast = () => useContext(ToastContext)

// ── Confirm Modal ──────────────────────────────────────────────
type ConfirmOptions = { title: string; message: string; confirmLabel?: string; danger?: boolean }
type ConfirmCtx = { confirm: (options: ConfirmOptions) => Promise<boolean> }

const ConfirmContext = createContext<ConfirmCtx>({ confirm: async () => false })
export const useConfirm = () => useContext(ConfirmContext)

export default function Providers({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [confirmState, setConfirmState] = useState<{ options: ConfirmOptions; resolve: (v: boolean) => void } | null>(null)

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500)
  }, [])

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise(resolve => {
      setConfirmState({ options, resolve })
    })
  }, [])

  function handleConfirm(result: boolean) {
    confirmState?.resolve(result)
    setConfirmState(null)
  }

  // DDIVault toast recipe: navy box, white text, a coloured left accent border.
  const toastAccent: Record<ToastType, string> = {
    success: '#16a34a',
    error:   '#dc2626',
    info:    '#2563eb',
  }

  return (
    <SessionProvider>
      <ToastContext.Provider value={{ showToast }}>
        <ConfirmContext.Provider value={{ confirm }}>
          {children}

          {/* Toast container */}
          <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none' }}>
            {toasts.map(toast => (
              <div key={toast.id} style={{
                background: '#1a2744', color: '#fff',
                borderLeft: `4px solid ${toastAccent[toast.type]}`,
                borderRadius: 'var(--radius)', padding: '10px 16px', fontSize: '13px', fontWeight: '500',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)', maxWidth: '340px', pointerEvents: 'auto',
                animation: 'fadeIn 0.2s ease'
              }}>
                {toast.message}
              </div>
            ))}
          </div>

          {/* Confirm modal */}
          {confirmState && (
            <div className="modal-overlay" style={{ zIndex: 9998 }}>
              <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: '28px', width: '100%', maxWidth: '400px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
                <h2 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 8px' }}>{confirmState.options.title}</h2>
                <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: '0 0 24px', lineHeight: '1.5' }}>{confirmState.options.message}</p>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button className="btn" onClick={() => handleConfirm(false)}>
                    Cancel
                  </button>
                  <button className={confirmState.options.danger ? 'btn btn-primary' : 'btn btn-navy'} onClick={() => handleConfirm(true)}>
                    {confirmState.options.confirmLabel || 'Confirm'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </ConfirmContext.Provider>
      </ToastContext.Provider>
    </SessionProvider>
  )
}
