'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import DeviceForm from '@/components/DeviceForm'
import Breadcrumb from '@/components/Breadcrumb'
export default function EditDevicePage({ params }: { params: Promise<{ id: string }> }) {
  const [device, setDevice] = useState(null)
  const [loading, setLoading] = useState(true)
  const [id, setId] = useState<string>('')
  const searchParams = useSearchParams()
  const fromSite = searchParams.get('from') === 'site'
  const fromSiteId = searchParams.get('siteId') || ''
  const fromSiteName = searchParams.get('siteName') || 'Site'

  useEffect(() => {
    params.then(p => {
      setId(p.id)
      fetch(`/api/devices/${p.id}`).then(r => r.json()).then(d => { setDevice(d); setLoading(false) })
    })
  }, [params])

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
  if (!device) return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Device not found</div>
  return (
    <div style={{ padding: '24px 28px' }}>
      <Breadcrumb crumbs={
        fromSite
          ? [
              { label: 'Sites', href: '/sites' },
              { label: fromSiteName, href: `/sites/${fromSiteId}` },
              { label: (device as any).name || 'Device', href: `/devices/${id}?from=site&siteId=${fromSiteId}&siteName=${encodeURIComponent(fromSiteName)}` },
              { label: 'Edit' },
            ]
          : [
              { label: 'Devices', href: '/devices' },
              { label: (device as any).name || 'Device', href: `/devices/${id}` },
              { label: 'Edit' },
            ]
      } />
      <DeviceForm initialData={device} deviceId={id} />
    </div>
  )
}
