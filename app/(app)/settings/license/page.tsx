import { redirect } from 'next/navigation'

// The NocVault suite apps (DDIVault, LogVault, SpanVault) link "Manage License"
// to {hub}/settings/license. NetVault renders all settings on a single /settings
// page with a License tab, so resolve that path here by redirecting to the tab.
export default function SettingsLicenseRedirect() {
  redirect('/settings?tab=license')
}
