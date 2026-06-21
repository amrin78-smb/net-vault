import { redirect } from 'next/navigation'
// Root is the suite entry point: send everyone to the launcher. The launcher
// redirects unauthenticated users to /login, and login returns to /launcher —
// so :3000 lands on login (if signed out) or the launcher (if signed in),
// instead of dropping straight into the NetVault product dashboard.
export default function Home() { redirect('/launcher') }
