'use client'
import { useState } from 'react'
import { useToast } from '@/app/providers'

type PreviewRow = {
  row: number
  name: string
  code: string
  country: string
  region: string
  action: 'create' | 'update' | 'skip'
  fills: string[]
  reason: string
}
type PreviewResponse = { preview: PreviewRow[]; total: number }
type ImportResult = {
  created: number
  updated: number
  skipped: number
  filledFields: number
  skippedRows: { row: number; name: string; reason: string }[]
}

const TEMPLATE_COLUMNS = [
  'Site Name', 'Code', 'Region', 'Country', 'Address', 'City',
  'Postal Code', 'Site Type', 'Coordinates', 'Phone', 'Contact Name', 'Contact Email',
]

function actionBadge(action: PreviewRow['action']) {
  if (action === 'create') return { bg: 'var(--tint-success)', color: 'var(--tint-success-fg)', label: 'Create' }
  if (action === 'update') return { bg: 'var(--tint-info)', color: 'var(--tint-info-fg)', label: 'Fill empty' }
  return { bg: 'var(--surface-subtle)', color: 'var(--text-muted)', label: 'Skip' }
}

export default function SitesImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { showToast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<PreviewRow[]>([])
  const [total, setTotal] = useState(0)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [dryResult, setDryResult] = useState<ImportResult | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)

  function downloadTemplate() {
    window.location.href = '/api/sites/import/template'
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setPreview([])
    setTotal(0)
    setResult(null)
    setDryResult(null)
    setShowSkipped(false)
    if (!f) return
    const formData = new FormData()
    formData.append('file', f)
    setPreviewLoading(true)
    try {
      const res = await fetch('/api/sites/import/preview', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok || data?.error) {
        showToast(data?.error || 'Failed to preview file', 'error')
        return
      }
      setPreview(data.preview || [])
      setTotal(data.total || 0)
    } catch {
      showToast('Failed to preview file', 'error')
    } finally {
      setPreviewLoading(false)
    }
  }

  async function runImport(dry: boolean) {
    if (!file) return
    setImportLoading(true)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('dryRun', dry ? 'true' : 'false')
    try {
      const res = await fetch('/api/sites/import', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok || data?.error) {
        setResult(null)
        setDryResult(null)
        showToast(data?.error || (dry ? 'Dry run failed' : 'Import failed'), 'error')
        return
      }
      if (dry) {
        setDryResult(data)
        setResult(null)
        setShowSkipped((data.skipped || 0) > 0)
      } else {
        setResult(data)
        setDryResult(null)
        setShowSkipped((data.skipped || 0) > 0)
        showToast(
          `Import complete: ${data.created} created, ${data.updated} updated, ${data.skipped} skipped`,
          data.skipped > 0 ? 'info' : 'success',
        )
        onImported()
      }
    } catch {
      showToast(dry ? 'Dry run failed' : 'Import failed', 'error')
    } finally {
      setImportLoading(false)
    }
  }

  const active = result || dryResult
  const truncated = total > preview.length

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: '24px', width: '100%', maxWidth: '860px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>Import sites</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', lineHeight: '1', color: 'var(--text-muted)' }}>×</button>
        </div>
        <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
          Importing creates new sites and fills in only empty fields on existing ones — it never overwrites data you already have.
        </p>

        {/* Template + file input */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' as const, marginBottom: '16px' }}>
          <button className="btn-secondary" onClick={downloadTemplate} style={{ fontSize: 'var(--text-base)', whiteSpace: 'nowrap' as const }}>
            ⬇ Download template
          </button>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{ fontSize: 'var(--text-base)' }} />
          {previewLoading && <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>Reading file…</span>}
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Template columns: {TEMPLATE_COLUMNS.join(', ')}.
        </div>

        {/* Preview table */}
        {preview.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', fontWeight: '500', marginBottom: '8px' }}>
              Preview — {total.toLocaleString()} row{total === 1 ? '' : 's'}
              {truncated && <span style={{ color: 'var(--text-muted)', fontWeight: '400' }}> (showing first {preview.length})</span>}
            </div>
            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: '320px', overflowY: 'auto' }}>
              <table style={{ fontSize: 'var(--text-sm)', width: '100%', minWidth: '640px' }}>
                <thead>
                  <tr style={{ background: 'var(--surface-subtle)' }}>
                    <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600', width: '56px' }}>Row</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600' }}>Name</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600' }}>Country</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600' }}>Region</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600' }}>Action</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600' }}>Will fill</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600' }}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => {
                    const badge = actionBadge(r.action)
                    return (
                      <tr key={i} style={{ borderTop: '1px solid var(--border-light)' }}>
                        <td style={{ padding: '7px 12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{r.row}</td>
                        <td style={{ padding: '7px 12px', color: 'var(--text-primary)', fontWeight: '500' }}>{r.name || '—'}</td>
                        <td style={{ padding: '7px 12px', color: 'var(--text-secondary)' }}>{r.country || '—'}</td>
                        <td style={{ padding: '7px 12px', color: 'var(--text-secondary)' }}>{r.region || '—'}</td>
                        <td style={{ padding: '7px 12px' }}>
                          <span style={{ fontSize: 'var(--text-xs)', fontWeight: '600', padding: '2px 8px', borderRadius: 'var(--radius-pill)', background: badge.bg, color: badge.color, whiteSpace: 'nowrap' as const }}>{badge.label}</span>
                        </td>
                        <td style={{ padding: '7px 12px', color: 'var(--text-secondary)' }}>{r.fills && r.fills.length ? r.fills.join(', ') : '—'}</td>
                        <td style={{ padding: '7px 12px', color: 'var(--text-muted)' }}>{r.reason || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '12px', flexWrap: 'wrap' as const }}>
              <button className="btn-secondary" onClick={() => runImport(true)} disabled={importLoading}>
                {importLoading && dryResult === null && result === null ? 'Validating…' : '🔍 Dry run'}
              </button>
              <button className="btn-primary" onClick={() => runImport(false)} disabled={importLoading}>
                {importLoading ? 'Importing…' : 'Import'}
              </button>
              {dryResult && !result && (
                <span style={{ fontSize: 'var(--text-base)', color: dryResult.skipped > 0 ? 'var(--tint-warn-fg)' : 'var(--tint-success-fg)', fontWeight: '500' }}>
                  ✓ {dryResult.created} will be created, {dryResult.updated} will be filled, {dryResult.skipped} skipped
                </span>
              )}
            </div>
          </div>
        )}

        {/* Result */}
        {active && typeof active.created === 'number' && (
          <div style={{ marginTop: '4px' }}>
            <div style={{ background: result ? 'var(--tint-success)' : 'var(--tint-info)', color: result ? 'var(--tint-success-fg)' : 'var(--tint-info-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '10px' }}>
              {result ? 'Import complete — ' : 'Dry run — '}
              {active.created} created, {active.updated} updated, {active.skipped} skipped · {active.filledFields} field{active.filledFields === 1 ? '' : 's'} filled
            </div>
            {active.skippedRows && active.skippedRows.length > 0 && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                <button onClick={() => setShowSkipped(s => !s)}
                  style={{ width: '100%', background: 'var(--tint-warn)', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: 'none', cursor: 'pointer' }}>
                  <span style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--tint-warn-fg)' }}>{active.skippedRows.length} row{active.skippedRows.length === 1 ? '' : 's'} skipped — see reasons</span>
                  <span style={{ fontSize: 'var(--text-base)', color: 'var(--tint-warn-fg)' }}>{showSkipped ? '▲' : '▼'}</span>
                </button>
                {showSkipped && (
                  <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
                    <table style={{ fontSize: 'var(--text-sm)', width: '100%' }}>
                      <thead>
                        <tr style={{ background: 'var(--surface-subtle)' }}>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600', width: '56px' }}>Row</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600', width: '200px' }}>Name</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '600' }}>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {active.skippedRows.map((s, i) => (
                          <tr key={i} style={{ borderTop: '1px solid var(--border-light)' }}>
                            <td style={{ padding: '7px 12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{s.row}</td>
                            <td style={{ padding: '7px 12px', color: 'var(--text-primary)', fontWeight: '500' }}>{s.name || '—'}</td>
                            <td style={{ padding: '7px 12px', color: 'var(--tint-danger-fg)' }}>{s.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
          <button className="btn-secondary" onClick={onClose} style={{ fontSize: 'var(--text-base)' }}>
            {result ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
