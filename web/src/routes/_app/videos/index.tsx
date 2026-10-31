import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { FolderOpen, Library as LibraryIcon, Plus, RefreshCw } from '@/components/icons'
import * as v from 'valibot'
import { AppLink, useGo } from '@/components/AppLink'
import { Meta } from '@/components/Meta'
import { PageHeader } from '@/components/PageHeader'
import { FindReport } from '@/components/FindReport'
import type { ViewerReport } from '@/components/library/ViewerReports'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import * as schema from '@/lib/schemas'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Section } from '@/components/Section'
import { Input } from '@/components/ui/input'
import { ListFilters } from '@/components/ListFilters'
import { LoadMore } from '@/components/LoadMore'
import { FormDialog, Wizard } from '@/components/Wizard'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, type Library } from '@/lib/api'
import { ago, number, size } from '@/lib/format'
import { message } from '@/lib/messages'
import { refresh, usePages } from '@/lib/query'
import { toast } from '@/lib/toast'

export const Route = createFileRoute('/_app/videos/')({
  validateSearch: (s: Record<string, unknown>) => (typeof s.q === 'string' && s.q ? { q: s.q } : {}),
  component: LibrariesPage,
})


const LibrarySchema = v.object({
  name: schema.name(),
  description: v.pipe(v.string(), v.trim(), v.maxLength(500, 'Descriptions can be up to 500 characters.')),
})

const NameOnly = v.object({ name: LibrarySchema.entries.name })

function NewLibrary({ onClose }: { onClose: () => void }) {
  const go = useGo()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState(0)

  async function create() {
    const parsed = v.safeParse(LibrarySchema, { name, description })
    setProblems(parsed.success ? {} : Object.fromEntries(parsed.issues.map((i) => [String(i.path?.[0]?.key), i.message])))
    if (!parsed.success) return setStep(parsed.issues[0].path?.[0]?.key === 'name' ? 0 : 1)
    setBusy(true)
    try {
      const made = await api<Library>('POST', '/v1/libraries', parsed.output)
      await refresh('/v1/libraries')
      toast('Library created.')
      onClose()
      go(`/videos/library/${made.id}`)
    } catch (err) {
      toast(message(err), 'danger')
      setBusy(false)
    }
  }

  return (
    <Wizard steps={[['Name', 'What the library is called.'], ['Description', 'Optional: what it holds, for your team.']]} step={step} onNext={() => (step === 0 ? (schema.check(NameOnly, { name }).name ? setProblems(schema.check(NameOnly, { name })) : (setProblems({}), setStep(1))) : void create())} onBack={() => setStep(0)} busy={busy} finish="Create library">
      {step === 0 && (
        <Field invalid={!!problems.name}>
          <FieldLabel htmlFor="lib-name">Name</FieldLabel>
          <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Course videos" aria-invalid={!!problems.name || undefined} />
          {problems.name ? <FieldError>{problems.name}</FieldError> : <FieldDescription>Only you see this name. You can change it later.</FieldDescription>}
        </Field>
      )}
      {step === 1 && (
        <Field invalid={!!problems.description}>
          <FieldLabel htmlFor="lib-description">Description (optional)</FieldLabel>
          <Textarea id="lib-description" rows={3} className="[&_textarea]:max-h-40" value={description} onChange={(e) => setDescription(e.target.value)} aria-invalid={!!problems.description || undefined} />
          {problems.description && <FieldError>{problems.description}</FieldError>}
        </Field>
      )}
    </Wizard>
  )
}

function LibrariesPage() {
  const { q = '' } = Route.useSearch()
  const libs = usePages<Library>(q ? `/v1/libraries?q=${encodeURIComponent(q)}` : '/v1/libraries', 12)
  const [open, setOpen] = useState(false)

  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta title="Libraries" description="Your video libraries: upload videos, organise them in folders and get links to share." />

      <PageHeader title="Libraries" actions={<>
        <ListFilters search="Search by name or description" />
        <FindReport<ViewerReport & { asset_id: string; title: string }>
          path={(code) => `/v1/playback-reports/${code}`}
          links={(r) => [['Video', <AppLink href={`/videos/${r.asset_id}?tab=troubleshoot`} className="hover:underline">{r.title || 'Untitled video'}</AppLink>]]}
        />
          <Button onClick={() => setOpen(true)}>
            <Plus />
            New library
          </Button>
      </>} />

      <FormDialog open={open} onOpenChange={setOpen} title="New library" description="Use a library for each website or project, so videos and settings stay apart.">
        <NewLibrary onClose={() => setOpen(false)} />
      </FormDialog>

      {libs.error ? (
        <Alert variant="error" className="flex items-center justify-between gap-3">
          <AlertDescription>{message(libs.error)}</AlertDescription>
          <Button size="sm" variant="outline" onClick={libs.refetch}>
            <RefreshCw />
            Try again
          </Button>
        </Alert>
      ) : !libs.rows ? (
        <Section bodyClassName="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
        </Section>
      ) : libs.rows.length === 0 ? (
        <Section><Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>{q ? 'Nothing matches' : 'No libraries yet'}</EmptyTitle>
            <EmptyDescription>{q ? 'Try another search, or clear the filters.' : 'Create a library, then upload your first video into it.'}</EmptyDescription>
          </EmptyHeader>
        </Empty></Section>
      ) : (
        <>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {libs.rows.map((l) => (
                <li key={l.id} className="min-w-0">
                  <Section
                    className="relative h-full transition-colors hover:bg-muted"
                    bodyClassName="grid grid-cols-2 gap-2 p-3"
                    title={<>
                      <span className="flex size-10 shrink-0 self-start items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <LibraryIcon className="size-5" />
                      </span>
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <AppLink href={`/videos/library/${l.id}`} className="min-w-0 truncate after:absolute after:inset-0 after:z-10">{l.name}</AppLink>
                          {l.is_default && <Badge variant="secondary">Default</Badge>}
                        </span>
                        <span className="line-clamp-2 min-h-[2lh] text-sm font-normal text-muted-foreground">{l.description || `${size(l.storage_bytes)} stored · Updated ${ago(l.updated_at)}`}</span>
                      </span>
                    </>}
                  >
                      <div className="rounded-lg bg-muted/60 p-3">
                        <p className="text-lg font-semibold font-sans [font-variant-numeric:tabular-nums]">{number(l.videos)}</p>
                        <p className="text-xs text-muted-foreground">{l.videos === 1 ? 'Video' : 'Videos'}</p>
                      </div>
                      <div className="rounded-lg bg-muted/60 p-3">
                        <p className="text-lg font-semibold font-sans [font-variant-numeric:tabular-nums]">{number(Math.round(l.minutes))}</p>
                        <p className="text-xs text-muted-foreground">Minutes</p>
                      </div>
                  </Section>
                </li>
              ))}
            </ul>
          <LoadMore more={!!libs.hasMore} loading={libs.loadingMore} onClick={libs.more} />
        </>
      )}
    </div>
  )
}
