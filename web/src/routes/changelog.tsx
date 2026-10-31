import { createFileRoute } from '@tanstack/react-router'
import changelog from '../../../CHANGELOG.md?raw'
import { ArrowLeft } from '@/components/icons'
import { headingId } from '@/lib/guides/guides'
import { useSetParams } from '@/hooks/use-set-params'
import { inline } from '@/components/Guide'
import { AppLink } from '@/components/AppLink'
import { Meta } from '@/components/Meta'
import { StatusTabs } from '@/components/StatusTabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/changelog')({
  validateSearch: (s: Record<string, unknown>) => ({ product: typeof s.product === 'string' ? s.product : '' }),
  component: Page,
})

// CHANGELOG.md's shape (.claude/rules/docs.md): "## Month Year" sections, each with "### New" and "### Fixed" bullet lists, every
// bullet starting with its product ("**Video: …**" or "Video: …").
type Item = { product: string; text: string }
type Month = { title: string; lists: { kind: string; items: Item[] }[] }
const PRODUCTS = ['Video', 'Workspace', 'Developers']
const item = (line: string): Item => {
  const m = line.match(/^(\*\*)?([A-Za-z]+): (.*)$/s)
  if (!m || !PRODUCTS.includes(m[2])) return { product: '', text: line }
  const text = m[3][0].toUpperCase() + m[3].slice(1) // the product word was the sentence's start
  return { product: m[2], text: m[1] ? `**${text}` : text }
}
const months: Month[] = changelog
  .split(/^## /m)
  .slice(1)
  .map((sec) => {
    const [title, ...rest] = sec.split('\n')
    const lists = rest
      .join('\n')
      .split(/^### /m)
      .slice(1)
      .map((l) => {
        const [kind, ...lines] = l.split('\n')
        return { kind: kind.trim(), items: lines.filter((x) => x.startsWith('- ')).map((x) => item(x.slice(2))) }
      })
    return { title: title.trim(), lists }
  })

// Solid labels, as changelogs people know draw them: green for what is new, blue for what was fixed.
const KIND: Record<string, string> = {
  New: 'bg-primary text-primary-foreground',
  Fixed: 'bg-sky-600 text-white dark:bg-sky-500',
}

function Page() {
  const { product } = Route.useSearch()
  const setParams = useSetParams()
  const count = (p: string) => months.flatMap((m) => m.lists.flatMap((l) => l.items)).filter((i) => !p || i.product === p).length
  const tabs = [{ value: '', label: 'All', count: count('') }, ...PRODUCTS.map((p) => ({ value: p, label: p, count: count(p) }))]
  const shown = months
    .map((m) => ({ ...m, lists: m.lists.map((l) => ({ ...l, items: l.items.filter((i) => !product || i.product === product) })).filter((l) => l.items.length) }))
    .filter((m) => m.lists.length)

  return (
    <main className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-10 md:px-6">
      <Meta title="Changelog" description="Every change to Ulka VMS you can see: new features and fixes, newest first." />
      <Button variant="ghost" size="sm" className="w-fit -ml-2" render={<AppLink href="/docs" />}><ArrowLeft />Docs</Button>
      <header className="grid gap-3 border-b pb-6">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Changelog</h1>
        <p className="max-w-[60ch] text-lg leading-relaxed text-muted-foreground text-pretty">New features and fixes, newest first.</p>
        <StatusTabs label="Product" value={product} items={tabs} onChange={(v) => setParams({ product: v })} />
      </header>
      {shown.map((m) => (
        <section key={m.title} className="grid gap-5 border-b py-6 last:border-b-0">
          <h2 id={headingId(m.title)} className="scroll-mt-20 text-2xl font-semibold tracking-tight">{m.title}</h2>
          {m.lists.map((l) => (
            <div key={l.kind} className="grid gap-3">
              <Badge variant="secondary" size="lg" className={cn('w-fit px-2.5 font-semibold', KIND[l.kind])}>{l.kind}</Badge>
              <ul className="grid gap-2 pl-5 text-[0.9375rem] leading-7 text-foreground/90 [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8125rem] [&_strong]:font-semibold [&_strong]:text-foreground">
                {l.items.map((it, i) => (
                  <li key={i} className="list-disc marker:text-muted-foreground">
                    {!product && it.product && <span className="mr-1.5 text-xs font-medium text-muted-foreground uppercase">{it.product}</span>}
                    {inline(it.text)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </main>
  )
}
