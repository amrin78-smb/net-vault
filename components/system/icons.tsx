/**
 * Local inline SVG icon set.
 *
 * Deliberately not an icon package: the brief rules out adding a dependency
 * for visual consistency, and the app already draws its icons inline. All
 * icons share a 24x24 viewBox and use currentColor so they inherit text
 * colour in both themes.
 *
 * Icons are decorative by default (aria-hidden). An icon that carries meaning
 * on its own needs a text label next to it, or an accessible name on the
 * control that contains it.
 */
type P = { size?: number; className?: string }
const s = (n = 16) => ({
  width: n, height: n, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false as const,
})
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const Icon = {
  dashboard: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  home: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>,
  site: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>,
  device: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" fill="none"/></svg>,
  circuit: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none"/><circle cx="8" cy="6" r="2.5"/><circle cx="16" cy="12" r="2.5"/><circle cx="10" cy="18" r="2.5"/></svg>,
  risk: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><path d="M12 2 2 20h20L12 2zm0 4 7.5 12h-15L12 6z"/><rect x="11" y="10" width="2" height="5" rx="1"/><rect x="11" y="16" width="2" height="2" rx="1"/></svg>,
  intelligence: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v5c0 1.66 3.58 3 8 3s8-1.34 8-3v-5" opacity="0.75"/><path d="M4 12.5v5c0 1.66 3.58 3 8 3s8-1.34 8-3v-5" opacity="0.5"/></svg>,
  compliance: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>,
  agent: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="7" cy="7" r="1.2"/><circle cx="7" cy="17" r="1.2"/></svg>,
  audit: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zm-4 4h8v1.5H9zm0 3h5v1.5H9z"/></svg>,
  users: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>,
  license: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg>,
  settings: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  search: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  help: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>,
  grid: ({ size }: P = {}) => <svg {...s(size)} fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>,
  menu: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M3 6h18M3 12h18M3 18h18"/></svg>,
  close: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M18 6 6 18M6 6l12 12"/></svg>,
  chevronRight: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="m9 18 6-6-6-6"/></svg>,
  chevronLeft: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="m15 18-6-6 6-6"/></svg>,
  chevronDown: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="m6 9 6 6 6-6"/></svg>,
  logout: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></svg>,
  shield: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  key: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 8-8M16 7l2.5 2.5M19 4l2 2"/></svg>,
  copy: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  check: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M20 6 9 17l-5-5"/></svg>,
  alert: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>,
  info: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>,
  refresh: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>,
  external: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>,
  filter: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>,
  inbox: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>,
  lock: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  eye: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M2 12s3.64-7 10-7 10 7 10 7-3.64 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>,
  eyeOff: ({ size }: P = {}) => <svg {...s(size)} {...stroke}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M2 2l20 20"/></svg>,
}
export type IconName = keyof typeof Icon
