import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Ellipsis, Trash2 } from '@/components/icons'
import { api, ApiError, type ApiKey } from '@/lib/api'
import { useGo } from '@/components/AppLink'
import { Facts } from '@/components/Facts'
import { Meta } from '@/components/Meta'
import { PageHeader } from '@/components/PageHeader'
import { Section } from '@/components/Section'
import { NotFound, Unavailable } from '@/components/ErrorPage'
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { when } from '@/lib/format'
import { message } from '@/lib/messages'
import { refresh, useGet } from '@/lib/query'
import { can, productName } from '@/lib/rules'
import { useMe } from '@/lib/session'
import { toast } from '@/lib/toast'
import { useCrumb } from '@/lib/crumb'

export const Route = createFileRoute('/_app/api-keys/$id')({ component: Page })

function Page() {
  const { id } = Route.useParams()
  const go = useGo()
  const me = useMe()
  const q = useGet<ApiKey>(`/v1/api-keys/${id}`)
  const [revoking, setRevoking] = useState(false)
  useCrumb(q.data?.name ?? '')
  if (q.error) return q.error instanceof ApiError && q.error.status === 404 ? <NotFound /> : <Unavailable error={q.error} />
  const k = q.data
  if (!k) return null // the shell shows the diamond until this has arrived

  async function revoke() {
    try {
      await api('DELETE', `/v1/api-keys/${id}`)
      toast('The key is revoked.')
      await refresh('/v1/api-keys')
      go('/api-keys')
    } catch (err) {
      toast(message(err), 'danger')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Meta title={k.name} description="An API key: what it can use, from where, and when it was last used." />
      <PageHeader
        title={k.name}
        actions={can(me, 'keys:write') && (
          <Menu>
            <MenuTrigger render={<Button variant="outline" size="icon" aria-label="Key actions" />}><Ellipsis /></MenuTrigger>
            <MenuPopup align="end">
              <MenuItem variant="destructive" onClick={() => setRevoking(true)}><Trash2 />Revoke</MenuItem>
            </MenuPopup>
          </Menu>
        )}
      />
      <AlertDialog open={revoking} onOpenChange={setRevoking}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {k.name}?</AlertDialogTitle>
            <AlertDialogDescription>Any software using this key stops working straight away. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" onClick={() => void revoke()} />}>Revoke</AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <Section title="Details">
        <Facts
          rows={[
            ['Starts with', <span className="font-mono">{k.prefix}…</span>],
            ['Can use', k.scopes.map((sc) => { const [prod, level] = sc.split(':'); return `${productName(prod)} (${level === 'write' ? 'read & write' : 'read'})` }).join(', ')],
            ['Allowed addresses', k.allowed_ips.length ? <span className="font-mono">{k.allowed_ips.join(', ')}</span> : 'Any address'],
            ['Last used', k.last_used_at ? when(k.last_used_at) : 'Never'],
            ['Expires', k.expires_at ? when(k.expires_at) : 'Never'],
            ['Created', when(k.created_at)],
          ]}
        />
      </Section>
    </div>
  )
}
