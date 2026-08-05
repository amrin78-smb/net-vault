import type { Metadata } from 'next'
import './globals.css'
import Providers from './providers'
import { THEME_INIT_SCRIPT } from '@/lib/theme'
import { CORNERS_INIT_SCRIPT } from '@/lib/corners'

// Inter is loaded via the @import in globals.css (with a system-ui fallback), NOT via
// next/font/google — that fetched from fonts.googleapis.com at BUILD time and broke the
// build on any machine/network that can't reach Google Fonts (offline / restricted LAN).

export const metadata: Metadata = {
  title: 'NetVault — Network Intelligence Platform',
  description: 'NetVault — IT Asset Management Platform',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply saved dark/light theme before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Same, for the rounded/square corner style. Must be a synchronous
            inline script — it reads localStorage, so it can't be an import. */}
        <script dangerouslySetInnerHTML={{ __html: CORNERS_INIT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
