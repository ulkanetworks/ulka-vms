import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { LoadError } from '@/components/LoadError'
import { Trash2 } from '@/components/icons'
import * as v from 'valibot'
import { useGo } from '@/components/AppLink'
import { Meta } from '@/components/Meta'
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/Section'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { SaveBar } from '@/components/SaveBar'

import { Textarea } from '@/components/ui/textarea'
import { api, type Library } from '@/lib/api'
import { TranscodingTab } from '@/components/library/Transcoding'
import { PlayerTab, SecurityTab } from '@/components/library/Settings'
import { save } from '@/lib/save'
import { useCrumb } from '@/lib/crumb'
import { message } from '@/lib/messages'
import { refresh, useGet } from '@/lib/query'
import { name as nameSchema, problemsOf, text } from '@/lib/schemas'
import { LIBRARY_TABS } from '@/lib/library-tabs'
import { toast } from '@/lib/toast'
import { rules } from '@/lib/rules'


export const Route = createFileRoute('/_app/videos/library/$lib/settings')({
  validateSearch: (s: Record<string, unknown>) => ({ tab: typeof s.tab === 'string' ? s.tab : '' }),
  component: Page,
})

function Page() {
  const { lib } = Route.useParams()
  const search = Route.useSearch()
  const q = useGet<Library>(`/v1/libraries/${lib}`)
  const library = q.data
  useCrumb(library?.name ?? '')
  const tab = LIBRARY_TABS.some((t) => t.id === search.tab) ? search.tab : 'general'

  const [actions, setActions] = useState<HTMLDivElement | null>(null) // the Player tab puts Save and Reset here
  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta title={library ? `${library.name} settings` : 'Library settings'} description="Name, player look, video quality and security for a library." />
      <header className="flex items-start justify-between gap-4">
        <h1 className="text-xl font-semibold">{library ? `${library.name}: ${LIBRARY_TABS.find((t) => t.id === tab)?.label ?? 'General'}` : <Skeleton className="h-7 w-56" />}</h1>
        <div ref={setActions} className="flex shrink-0 gap-2" />
      </header>
      {q.error ? (
        <LoadError error={q.error} retry={q.refetch} />
      ) : !library ? (
        <Skeleton className="h-64 w-full max-w-3xl" />
      ) : (
        <div className="min-w-0">
          {tab === 'general' && <div className="max-w-2xl"><General key={`${library.id}-${library.name}-${library.description}`} lib={library} /></div>}
          {tab === 'player' && <PlayerTab lib={library} actions={actions} />}
          {tab === 'transcoding' && <TranscodingTab lib={library} />}
          {tab === 'security' && <div><SecurityTab lib={library} /></div>}
        </div>
      )}
    </div>
  )
}

function General({ lib }: { lib: Library }) {
  const [name, setName] = useState(lib.name)
  const [description, setDescription] = useState(lib.description)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const go = useGo()

  async function submit() {
    const parsed = v.safeParse(v.object({ name: nameSchema(), description: text(rules.limits.description, 'invalid_library') }), { name, description })
    setProblems(parsed.success ? {} : problemsOf(parsed.issues))
    if (!parsed.success) return
    setBusy(true)
    await save(`/v1/libraries/${lib.id}`, 'PATCH', { name: parsed.output.name, description: parsed.output.description })
    setBusy(false)
  }
  async function remove() {
    try {
      await api('DELETE', `/v1/libraries/${lib.id}`)
      await refresh('/v1/libraries')
      toast('Library deleted.')
      go('/videos')
    } catch (err) {
      toast(message(err), 'danger')
    }
    setConfirm(false)
  }

  return (
    <div className="grid max-w-2xl gap-4">
      <Section title="About this library" action={<SaveBar dirty={name !== lib.name || description !== lib.description} saving={busy} onSave={() => void submit()} onDiscard={() => (setProblems({}), setName(lib.name), setDescription(lib.description))} />}>
          <div className="flex flex-col gap-4">
            <Field invalid={!!problems.name}>
              <FieldLabel htmlFor="lib-name">Name</FieldLabel>
              <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={(!!problems.name) ? true : undefined} />
              {problems.name && <FieldError>{problems.name}</FieldError>}
            </Field>
            <Field invalid={!!problems.description}>
              <FieldLabel htmlFor="lib-desc">Description</FieldLabel>
              <Textarea id="lib-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="[&_textarea]:max-h-40" aria-invalid={!!problems.description || undefined} />
              {problems.description && <FieldError>{problems.description}</FieldError>}
            </Field>
          </div>
      </Section>
      <Section
        title="Delete this library"
        description={lib.is_default
                ? 'This is your main library, where videos go when you don’t pick another. It can’t be deleted.'
                : 'A library can only be deleted when it has no videos, including videos in the trash. Move or delete them first.'}
        action={!lib.is_default && (
            <Button variant="destructive" className="shrink-0" onClick={() => setConfirm(true)}><Trash2 />
              Delete library
            </Button>
          )}
      />
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{lib.name}”?</AlertDialogTitle>
            <AlertDialogDescription>Its folders and settings go too. This can’t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep it</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" />} onClick={() => void remove()}>
              Delete library
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  )
}


