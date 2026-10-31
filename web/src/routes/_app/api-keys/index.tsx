import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { KeyRound, Ellipsis, Plus, Trash2 } from '@/components/icons'
import { NewApiKey } from '@/components/NewApiKey'
import { useGo } from '@/components/AppLink'
import { Help } from '@/components/Help'
import { Meta } from '@/components/Meta'
import { PageHeader } from '@/components/PageHeader'
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Section } from '@/components/Section'
import { DataTable, type Column } from '@/components/DataTable'
import { ListFilters } from '@/components/ListFilters'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { api, type ApiKey } from '@/lib/api'
import { ago, when, dt } from '@/lib/format'
import { message } from '@/lib/messages'
import { dropRows, usePager } from '@/lib/query'
import { can, productName } from '@/lib/rules'
import { useMe } from '@/lib/session'
import { StatusBadge } from '@/components/StatusBadge'
import { toast } from '@/lib/toast'

export const Route = createFileRoute('/_app/api-keys/')({
  validateSearch: (s: Record<string, unknown>) => ({ new: s.new === undefined ? '' : String(s.new), ...(typeof s.q === 'string' && s.q ? { q: s.q } : {}) }),
  component: Page,
})

type Key = ApiKey

const date = dt(undefined, { dateStyle: 'medium' })

const columns = (busy: boolean, revoke: (k: Key) => void): Column<Key>[] => [
  {
    id: 'name',
    header: 'Name',
    cell: ({ row: { original: k } }) => (
      <>
        <span className="block font-medium">{k.name}</span>
        <span className="mt-1 block font-mono text-xs text-muted-foreground">
          {k.prefix}…{k.allowed_ips.length > 0 && ` · ${k.allowed_ips.length === 1 ? k.allowed_ips[0] : `${k.allowed_ips.length} addresses`}`}
        </span>
      </>
    ),
  },
  {
    id: 'scopes',
    header: 'Can use',
    cell: ({ row: { original: k } }) => (
      <span className="flex flex-wrap gap-1">
        {k.scopes.map((sc) => {
          const [prod, level] = sc.split(':')
          return (
            <Badge key={sc} variant={level === 'write' ? 'outline' : 'secondary'}>
              {productName(prod)} · {level === 'write' ? 'read & write' : 'read'}
            </Badge>
          )
        })}
      </span>
    ),
  },
  {
    id: 'used',
    header: 'Last used',
    cell: ({ row: { original: k } }) => (
      <span className="text-muted-foreground" title={k.last_used_at ? when(k.last_used_at) : undefined}>
        {k.last_used_at ? ago(k.last_used_at) : 'Never'}
      </span>
    ),
  },
  {
    id: 'expires',
    header: 'Expires',
    cell: ({ row: { original: k } }) =>
      !k.expires_at ? (
        <span className="text-muted-foreground">Never</span>
      ) : new Date(k.expires_at) < new Date() ? (
        <StatusBadge variant="destructive">Expired</StatusBadge>
      ) : (
        <span className="text-muted-foreground" title={when(k.expires_at)}>{date.format(new Date(k.expires_at))}</span>
      ),
  },
  { id: 'created', header: 'Created', cell: ({ row: { original: k } }) => <span className="text-muted-foreground" title={when(k.created_at)}>{ago(k.created_at)}</span> },
  {
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row: { original: k } }) => (
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${k.name}`} disabled={busy} />}>
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem variant="destructive" onClick={() => revoke(k)}>
            <Trash2 />
            Revoke…
          </MenuItem>
        </MenuPopup>
      </Menu>
    ),
  },
]

function Page() {
  const me = useMe()
  if (!can(me, 'keys:read'))
    return (
      <Section><Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><KeyRound /></EmptyMedia>
          <EmptyTitle>Only admins and owners manage API keys</EmptyTitle>
          <EmptyDescription>Ask one of them if your software needs a key.</EmptyDescription>
        </EmptyHeader>
      </Empty></Section>
    )
  return <Keys />
}

function Keys() {
  const { q = '', new: isNew } = Route.useSearch()
  const list = usePager<Key>(q ? `/v1/api-keys?q=${encodeURIComponent(q)}` : '/v1/api-keys')
  const [creating, setCreating] = useState(isNew !== '')
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<Key | null>(null)
  const go = useGo()

  async function revoke(id: string) {
    setBusy(true)
    dropRows('/v1/api-keys', [id])
    try {
      await api('DELETE', `/v1/api-keys/${id}`)
      toast('The key was revoked. Anything still using it stops working now; give that software a new key.')
    } catch (err) {
      toast(message(err), 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta title="API keys" description="Create and revoke the keys your servers use to call the API." />
      <PageHeader title="API keys" actions={<>
        <Help label="What is an API key?">A key is a password for your own software rather than a person. Your server includes it with each request so Ulka VMS knows the request comes from your workspace. Each key can use only the products you choose; owners and admins create them.</Help>
        <ListFilters search="Search by name or key start" />
          
          <Button onClick={() => setCreating(true)}><Plus />New key</Button>
      </>} />

      <NewApiKey open={creating} onOpenChange={setCreating} />

      <AlertDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Any software using this key stops working straight away. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" onClick={() => revoking && void revoke(revoking.id)} />}>
              Revoke
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <DataTable
        columns={columns(busy, setRevoking)}
        pager={list}
        narrowed={!!q}
        rowKey={(k) => k.id}
        onRowClick={(k) => go(`/api-keys/${k.id}`)}
        rowLabel={(k) => `Open ${k.name}`}
        empty={
          <Section><Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRound />
              </EmptyMedia>
              <EmptyTitle>No API keys yet</EmptyTitle>
              <EmptyDescription>Create a key when you want your own server or app to use Ulka VMS. One per server lets you cut off one without touching the rest.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setCreating(true)}><Plus />New key</Button>
            </EmptyContent>
          </Empty></Section>
        }
      />
    </div>
  )
}
