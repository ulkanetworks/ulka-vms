import { createFileRoute } from '@tanstack/react-router'
import { groups, guides } from '@/lib/guides/guides'
import { AppLink } from '@/components/AppLink'
import { Meta } from '@/components/Meta'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/Section'
import { docsPage } from '@/components/docs/Toc'

export const Route = createFileRoute('/docs/')({ component: Page })

const doors = [
  { href: '/docs/guides/getting-started', name: 'Guides', text: 'How to upload and play videos, put a distribution on the CDN, resize images, and run your workspace.' },
  { href: '/docs/api', name: 'API reference', text: "Every operation, field, webhook event and error code, read from the API's own description." },
  { href: '/changelog', name: 'Changelog', text: 'New features and fixes as they ship, newest first.' },
]

function Page() {
  return (
    <div className={docsPage(false)}>
      <Meta title="Docs" description="How to use Ulka VMS for video, and the full API reference." />
      <section className="grid gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Ulka VMS docs</h1>
        <p className="text-muted-foreground">Guides walk you through each product step by step. The API reference lists every operation in detail.</p>
        <div className="mt-3"><Button render={<AppLink href="/docs/guides/getting-started" />}>Start here: Getting started</Button></div>
      </section>

      <nav className="grid gap-4 sm:grid-cols-3" aria-label="Docs">
        {doors.map((d) => (
          <AppLink key={d.href} href={d.href}>
            <Section className="h-full hover:bg-muted" title={d.name} description={d.text} />
          </AppLink>
        ))}
      </nav>

      <section className="grid gap-6 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g} className="grid content-start gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">{g}</h2>
            <ul className="grid gap-3">
              {guides.filter((x) => x.group === g).map((x) => (
                <li key={x.slug} className="grid gap-0.5 text-sm">
                  <AppLink href={`/docs/guides/${x.slug}`} className="font-medium hover:underline">{x.title}</AppLink>
                  <span className="text-muted-foreground">{x.summary}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  )
}
