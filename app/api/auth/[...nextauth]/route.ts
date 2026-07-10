import NextAuth from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { query } from '@/lib/db'
import { getUserApps } from '@/lib/appAccess'
import bcrypt from 'bcryptjs'

const authOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: { email: { label: 'Email', type: 'email' }, password: { label: 'Password', type: 'password' } },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null
        const res = await query('SELECT * FROM users WHERE email = $1', [credentials.email])
        const user = res.rows[0]
        if (!user) return null
        const valid = await bcrypt.compare(credentials.password, user.password_hash)
        if (!valid) return null
        // Load assigned sites for site_admin
        let siteIds: number[] = []
        if (user.role === 'site_admin') {
          const sitesRes = await query('SELECT site_id FROM user_sites WHERE user_id = $1', [user.id])
          siteIds = sitesRes.rows.map((r: any) => r.site_id)
        }
        // Start the trial clock on the very first successful login
        try {
          const idRes = await query(
            "SELECT value FROM app_settings WHERE key = 'install_date'"
          )
          if (!idRes.rows[0]?.value) {
            await query(
              "INSERT INTO app_settings (key, value) VALUES ('install_date', $1) ON CONFLICT (key) DO UPDATE SET value = $1 WHERE app_settings.value = ''",
              [new Date().toISOString().split('T')[0]]
            )
          }
        } catch {}

        const apps = await getUserApps(user.id, user.role)

        return { id: String(user.id), name: user.name, email: user.email, role: user.role, siteIds, apps }
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }: any) {
      if (user) { token.role = user.role; token.id = user.id; token.siteIds = user.siteIds || []; token.apps = user.apps || [] }
      return token
    },
    async session({ session, token }: any) {
      if (session.user) { session.user.role = token.role; session.user.id = token.id; session.user.siteIds = token.siteIds || []; session.user.apps = token.apps || [] }
      return session
    }
  },
  pages: { signIn: '/login' },
  session: { strategy: 'jwt' as const },
  secret: process.env.NEXTAUTH_SECRET,
}

const handler = NextAuth(authOptions)
export { handler as GET, handler as POST, authOptions }
