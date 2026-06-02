'use client';

import { useEffect, useRef } from 'react';

// ── Skeleton block ────────────────────────────────────────────
export function Skeleton({ width = '100%', height = 14, radius = 6, style }: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: React.CSSProperties;
}) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius, ...style }} />;
}

// ── Table skeleton ────────────────────────────────────────────
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: '4px 0' }}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: 16, padding: '12px 16px', alignItems: 'center' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} height={12} width={c === 0 ? 120 : `${Math.max(40, 100 / cols)}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Card skeleton ─────────────────────────────────────────────
export function CardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: 20,
        }}>
          <Skeleton height={28} width="50%" />
          <div style={{ height: 8 }} />
          <Skeleton height={12} width="70%" />
        </div>
      ))}
    </>
  );
}

// ── Empty state ───────────────────────────────────────────────
export function EmptyState({ icon, title, message, actionLabel, onAction }: {
  icon?: React.ReactNode;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '52px 24px', textAlign: 'center', color: 'var(--text-muted)',
    }}>
      {icon && (
        <div style={{
          width: 56, height: 56, borderRadius: 14, marginBottom: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-muted)',
        }}>
          {icon}
        </div>
      )}
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      {message && <div style={{ fontSize: 13, marginTop: 6, maxWidth: 420 }}>{message}</div>}
      {actionLabel && onAction && (
        <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// ── Page header ───────────────────────────────────────────────
export function PageHeader({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
      <div>
        <div className="page-title">{title}</div>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {children && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────
export function Spinner({ size = 14, color = 'var(--primary)' }: { size?: number; color?: string }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size,
      border: `2px solid var(--border)`, borderTopColor: color,
      borderRadius: '50%', animation: 'spin 0.8s linear infinite',
    }} />
  );
}

// ── Hook: close on Escape ─────────────────────────────────────
export function useEscape(cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}
