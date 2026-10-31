import { useState } from 'react'
import { Link, createFileRoute, useRouterState } from '@tanstack/react-router'
import { ArrowLeft } from '@/components/icons'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Section } from '@/components/Section'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Meta } from '@/components/Meta'
import { Fields } from '@/components/docs/Fields'
import { Operation } from '@/components/docs/Operation'
import { Text } from '@/components/docs/Text'
import { Toc, docsPage } from '@/components/docs/Toc'
import { METHODS, groupId, sectionId as slug, type Operation as Op, type Spec } from '@/lib/docs/spec'
import { useGet } from '@/lib/query'
import { message, messageFor } from '@/lib/messages'

// The API reference, read from the API's own description (GET /v1/openapi.json); nothing here is written twice.
// Cards first; a card opens its section (?s=<id>), so the back button and links work.
export const Route = createFileRoute('/docs/api')({
  validateSearch: (s: Record<string, unknown>) => ({ s: typeof s.s === 'string' ? s.s : '' }),
  component: Page,
})

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
const lead = 'text-sm text-muted-foreground'

type Entry = { method: string; path: string; op: Op; tag: string }

function Page() {
  const { s } = Route.useSearch()
  const hash = useRouterState({ select: (r) => r.location.hash })
  const { data: spec, error } = useGet<Spec>('/v1/openapi.json')
  const [q, setQ] = useState('')

  const entries: Entry[] = spec
    ? Object.entries(spec.paths).flatMap(([path, ops]) => METHODS.filter((m) => ops[m]).map((method) => ({ method, path, op: ops[method], tag: ops[method].tags?.[0] ?? '' })))
    : []
  const events = spec?.webhooks ? Object.entries(spec.webhooks).map(([name, ops]) => ({ name, op: ops.post })) : []
  const cards = [
    ...(spec?.tags ?? []).map((t) => ({ id: slug(t.name), name: t.name, text: t.description ?? '', count: entries.filter((e) => e.tag === t.name).length, unit: 'operation' })),
    { id: 'events', name: 'Webhook events', text: 'What Ulka VMS sends to your webhook addresses, and how to check it came from Ulka VMS.', count: events.length, unit: 'event' },
    { id: 'errors', name: 'Errors', text: 'The error codes any operation can return, and what each one means.', count: Object.keys(spec?.['x-ulka-common-errors'] ?? {}).length, unit: 'code' },
  ]

  const current = cards.find((c) => c.id === s) ?? null
  const needle = q.trim().toLowerCase()
  const results = needle ? entries.filter((e) => `${e.method} ${e.path} ${e.op.summary} ${e.op.description}`.toLowerCase().includes(needle)) : []
  const shown = current ? entries.filter((e) => e.tag === current.name) : []
  // A long section is split into the spec's groups (x-ulka-groups), in their order; a short one is a single list.
  const groupNames = spec?.tags?.find((t) => t.name === current?.name)?.['x-ulka-groups'] ?? []
  const parts = groupNames.length ? groupNames.map((g) => ({ name: g, ops: shown.filter((e) => e.op['x-ulka-group'] === g) })) : [{ name: '', ops: shown }]
  // "On this page": the open section's operations or events, under their groups' names.
  const toc = needle || !current ? [] : current.id === 'events' ? events.map((e) => ({ id: e.name, label: e.name })) : parts.flatMap((p) => [
    ...(p.name ? [{ id: groupId(p.name), label: p.name, heading: true }] : []),
    ...p.ops.map((e) => ({ id: e.op.operationId, label: e.op.summary ?? e.path })),
  ])

  return (
    <div className={docsPage(toc.length > 0)}>
      <Meta title={current ? `${current.name} · API reference` : 'API reference'} description="The Ulka VMS API: videos, playback, webhooks and your workspace." />
      <div className="grid content-start gap-4">
        {error && <Alert variant="error"><AlertDescription>{message(error)}</AlertDescription></Alert>}
        {spec ? (
          <>
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search every operation, like “purge” or “/v1/assets”" aria-label="Search every operation" />

            {needle ? (
              <section className="grid gap-4">
                <h2 className="text-lg font-semibold">{plural(results.length, 'match')}</h2>
                {results.length ? (
                  results.map((e) => (
                    <div key={e.method + e.path} className="grid gap-1">
                      <span className="text-xs text-muted-foreground">{e.tag}</span>
                      <Operation spec={spec} method={e.method} path={e.path} op={e.op} />
                    </div>
                  ))
                ) : (
                  <p className={lead}>Nothing matches “{q}”. Try a word from the path, like “assets” or “purges”.</p>
                )}
              </section>
            ) : !current ? (
              <>
                <section className="grid gap-3">
                  <h1 className="text-3xl font-semibold tracking-tight">
                    {spec.info.title} <span className="text-sm font-normal text-muted-foreground">v{spec.info.version}</span>
                  </h1>
                  <div className="grid gap-3 text-sm text-muted-foreground">
                    <Text text={spec.info.description} />
                  </div>
                </section>
                <nav className="grid gap-4 sm:grid-cols-2" aria-label="Sections">
                  {cards.map((c) => (
                    <Link key={c.id} to="/docs/api" search={{ s: c.id }}>
                      <Section className="h-full hover:bg-muted" title={c.name} description={c.text} bodyClassName="grid content-start">
                          <Badge variant="secondary" className="w-fit">{plural(c.count, c.unit)}</Badge>
                      </Section>
                    </Link>
                  ))}
                </nav>
              </>
            ) : (
              <section className="grid gap-4">
                <Link to="/docs/api" search={{ s: '' }} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                  <ArrowLeft />All sections
                </Link>
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight">{current.name}</h1>
                  <p className={lead}>{current.text}</p>
                </div>

                {current.id === 'events' ? (
                  <div className="grid gap-2">
                    {events.map((ev) => (
                      <Collapsible key={ev.name} id={ev.name} defaultOpen={hash === ev.name} className="scroll-mt-20">
                        <Section flush>
                          <CollapsibleTrigger className="flex w-full items-baseline gap-3 px-4 py-3 text-left">
                            <code>{ev.name}</code> <span className="text-muted-foreground">{ev.op?.summary}</span>
                          </CollapsibleTrigger>
                          <CollapsiblePanel className="grid gap-3 border-t p-4 text-sm">
                            {ev.op?.description && <Text text={ev.op.description} />}
                            {ev.op?.requestBody?.content?.['application/json']?.schema && <Fields spec={spec} schema={ev.op.requestBody.content['application/json'].schema} />}
                          </CollapsiblePanel>
                        </Section>
                      </Collapsible>
                    ))}
                  </div>
                ) : current.id === 'errors' ? (
                  <>
                    <Table>
                      <TableBody>
                        {Object.entries(spec['x-ulka-common-errors'] ?? {}).map(([code, why]) => (
                          <TableRow key={code}>
                            <TableCell className="align-top"><code className="font-medium">{code}</code></TableCell>
                            <TableCell className="whitespace-normal">
                              {why}
                              {messageFor(code) && <span className="mt-1 block text-muted-foreground">Message: {messageFor(code)}</span>}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <p className={lead}>Codes specific to one operation are listed with it.</p>
                  </>
                ) : (
                  parts.map((p) => (
                    <div key={p.name} className="grid gap-2">
                      {p.name && <h2 id={groupId(p.name)} className="mt-4 scroll-mt-20 text-lg font-semibold">{p.name}</h2>}
                      {/* Keyed by the hash too, so following a link to an operation already on the page opens it. */}
                      {p.ops.map((e) => (
                        <Operation key={e.method + e.path + (hash === e.op.operationId ? '#' : '')} spec={spec} method={e.method} path={e.path} op={e.op} open={hash === e.op.operationId} />
                      ))}
                    </div>
                  ))
                )}
              </section>
            )}
          </>
        ) : (
          !error && <Skeleton className="h-40 w-full" />
        )}
      </div>
      <Toc items={toc} />
    </div>
  )
}
