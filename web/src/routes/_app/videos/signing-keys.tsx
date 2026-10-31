import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { CopyButton } from '@/components/CopyButton'
import { CircleCheck, LockKeyhole, Plus, Copy, Ellipsis, Trash2 } from '@/components/icons'
import { Help } from '@/components/Help'
import { PageHeader } from '@/components/PageHeader'
import { Meta } from '@/components/Meta'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Section } from '@/components/Section'
import { DataTable, type Column } from '@/components/DataTable'
import { ListFilters } from '@/components/ListFilters'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { api } from '@/lib/api'
import { copy } from '@/lib/copy'
import { ago, when } from '@/lib/format'
import { message } from '@/lib/messages'
import { refresh, usePager } from '@/lib/query'
import { CopyText } from '@/components/CopyText'
import { AppLink } from '@/components/AppLink'
import { toast } from '@/lib/toast'

export const Route = createFileRoute('/_app/videos/signing-keys')({
  validateSearch: (s: Record<string, unknown>) => (typeof s.q === 'string' && s.q ? { q: s.q } : {}),
  component: Page,
})

type Key = { id: string; created_at: string }

const columns = (busy: boolean, remove: (k: Key) => void): Column<Key>[] => [
  { id: 'id', header: 'Key ID', cell: ({ row: { original: k } }) => <CopyText value={k.id} what="key ID" /> },
  { id: 'created', header: 'Created', cell: ({ row: { original: k } }) => <span className="text-muted-foreground" title={when(k.created_at)}>{ago(k.created_at)}</span> },
  {
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row: { original: k } }) => (
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for key ${k.id}`} disabled={busy} />}>
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => void copy(k.id, 'Key ID')}>
            <Copy />
            Copy key ID
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={() => remove(k)}>
            <Trash2 />
            Delete…
          </MenuItem>
        </MenuPopup>
      </Menu>
    ),
  },
]

function Page() {
  const { q = '' } = Route.useSearch()
  const list = usePager<Key>(q ? `/v1/signing-keys?q=${encodeURIComponent(q)}` : '/v1/signing-keys')
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<Key | null>(null)

  async function create() {
    setBusy(true)
    try {
      setCreated(await api<{ id: string; secret: string }>('POST', '/v1/signing-keys'))
      toast('Signing key created. Copy its secret now.')
      await refresh('/v1/signing-keys')
    } catch (err) {
      toast(message(err), 'danger')
    } finally {
      setBusy(false)
    }
  }
  async function remove(id: string) {
    setBusy(true)
    try {
      await api('DELETE', `/v1/signing-keys/${id}`)
      toast('The signing key was deleted. Links signed with it stopped working; sign with another key.')
      await refresh('/v1/signing-keys')
    } catch (err) {
      toast(message(err), 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta title="Video signing keys" description="Secret keys your server uses to let your own visitors watch private videos." />
      <PageHeader title="Video signing keys" actions={<>
        <Help label="What is a signing key?">A private video plays only from a signed link. A signing key is the secret your server signs those links with, and Ulka VMS checks each one against it, so a copied link stops working when its time runs out. Every key here works at once, so you can replace one without a gap. Skip this page if all your videos are public. It isn't an API key, and CDN distributions protect files with their own link keys, under each distribution's Security.</Help>
        <ListFilters search="Search by key ID" />
        <Button disabled={busy} onClick={create}>
          {busy ? <Spinner /> : <Plus />}
          New signing key
        </Button>
      </>} />

      {created && (
        <Alert variant="success">
          <CircleCheck />
          <AlertTitle>Signing key created</AlertTitle>
          <AlertDescription className="grid w-full gap-3">
            <p>Give both to whoever runs your server. It signs each link with the secret and names the key by its ID.</p>
            <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
              <span className="text-sm font-medium text-foreground">Key ID</span>
              <CopyText value={created.id} what="key ID" />
              <span className="text-sm font-medium text-foreground">Secret</span>
              <InputGroup>
                <InputGroupInput readOnly value={created.secret} aria-label="Signing secret" className="font-mono" />
                <InputGroupAddon align="inline-end">
                  <CopyButton value={created.secret} what="signing secret" />
                </InputGroupAddon>
              </InputGroup>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs">The secret is shown only now and can't be retrieved later.</span>
              <Button size="sm" variant="outline" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this key?</AlertDialogTitle>
            <AlertDialogDescription>Every link signed with it stops working at once, even for people watching, until your server signs with another key. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" onClick={() => deleting && void remove(deleting.id)} />}>
              Delete key
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>


      <DataTable
        columns={columns(busy, setDeleting)}
        pager={list}
        narrowed={!!q}
        rowKey={(k) => k.id}
        empty={
          <Section><Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LockKeyhole />
              </EmptyMedia>
              <EmptyTitle>No signing keys yet</EmptyTitle>
              <EmptyDescription>Videos set to private can't play for anyone until you create one.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button disabled={busy} onClick={create}>
                <Plus />
                New signing key
              </Button>
            </EmptyContent>
          </Empty></Section>
        }
      />

      <Collapsible>
        <CollapsibleTrigger render={<Button variant="link" className="px-0" />}>
            For your developer: how to sign a link
          </CollapsibleTrigger>
        <CollapsiblePanel className="mt-2 text-sm text-muted-foreground">
          Either ask Ulka VMS to sign (<code>POST /v1/signed-urls</code>, signed with your newest key) or sign yourself: join <code>exp</code>, <code>acl</code> and <code>kid</code> (the key ID) with <code>~</code>, then add <code>~hmac=</code> and the HMAC-SHA256 in hex of everything before it, using the base64-decoded secret. Put it on the video's address as <code>?token=</code>. The steps and a code example are in <AppLink href="/docs/guides/play-video" className="text-primary">Play a video</AppLink>.
        </CollapsiblePanel>
      </Collapsible>
    </div>
  )
}
