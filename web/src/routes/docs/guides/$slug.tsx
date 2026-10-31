import { createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight } from '@/components/icons'
import { guides, headingId } from '@/lib/guides/guides'
import { AppLink } from '@/components/AppLink'
import { NotFound } from '@/components/ErrorPage'
import { Guide } from '@/components/Guide'
import { Meta } from '@/components/Meta'
import { Button } from '@/components/ui/button'
import { Toc, docsPage } from '@/components/docs/Toc'

export const Route = createFileRoute('/docs/guides/$slug')({
  loader: ({ params }) => {
    const i = guides.findIndex((g) => g.slug === params.slug)
    if (i < 0) throw notFound()
    return { guide: guides[i], prev: guides[i - 1], next: guides[i + 1] }
  },
  notFoundComponent: NotFound,
  component: Page,
})

function Page() {
  const { guide, prev, next } = Route.useLoaderData()
  const toc = [...guide.body.matchAll(/^## (.+)$/gm)].map((m) => ({ id: headingId(m[1]), label: m[1] }))
  return (
    <div className={docsPage(true)}>
      <Meta title={`${guide.title} · Guides`} description={guide.summary} />
      <article className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
        <header className="grid gap-3 border-b pb-6">
          <p className="text-sm font-medium text-primary">{guide.group}</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{guide.title}</h1>
          <p className="max-w-[60ch] text-lg leading-relaxed text-muted-foreground text-pretty">{guide.summary}</p>
        </header>
        <Guide key={guide.slug} body={guide.body} origin={location.origin} />

        <footer className="mt-8 flex justify-between gap-3">
          {prev ? (
            <Button variant="outline" render={<AppLink href={`/docs/guides/${prev.slug}`} />}><ArrowLeft />{prev.title}</Button>
          ) : (
            <span />
          )}
          {next && <Button variant="outline" render={<AppLink href={`/docs/guides/${next.slug}`} />}>{next.title}<ArrowRight /></Button>}
        </footer>
      </article>
      <Toc key={guide.slug} items={toc} />
    </div>
  )
}
