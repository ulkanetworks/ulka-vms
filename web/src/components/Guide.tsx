// Renders a guide's text format (see guides.ts) as blocks; nothing goes through dangerouslySetInnerHTML.
import { Fragment, useMemo, type ReactNode } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Code } from '@/components/Code'
import { headingId } from '@/lib/guides/guides'
import { parse } from '@/lib/guides/parse'

// Inline: `code`, **bold** and [text](href), in that order of precedence.
export function inline(s: string): ReactNode {
  return [...s.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|([^`*[]+|[`*[])/g)].map((m, i) => {
    if (m[1] !== undefined) return <code key={i}>{m[1]}</code>
    if (m[2] !== undefined) return <strong key={i}>{m[2]}</strong>
    if (m[3] !== undefined) {
      const ext = m[4].startsWith('http')
      return (
        <a key={i} href={m[4]} target={ext ? '_blank' : undefined} rel={ext ? 'noreferrer' : undefined}>
          {m[3]}
        </a>
      )
    }
    return <Fragment key={i}>{m[5]}</Fragment>
  })
}

// A label for a code block, from how it starts.
const kind = (code: string) => (code.startsWith('curl') ? 'Terminal' : code.startsWith('{') ? 'JSON' : code.startsWith('<') ? 'HTML' : /^(import|new|const) /.test(code) ? 'JavaScript' : '')

export function Guide({ body, origin }: { body: string; origin: string }) {
  const blocks = useMemo(() => parse(body, origin), [body, origin])
  // Reading width, a calm body colour, and headings that step down: h2 opens a section with a rule, h3 a part of it.
  return (
    <div className="grid max-w-[72ch] grid-cols-[minmax(0,1fr)] gap-4 text-[0.9375rem] leading-7 text-foreground/90 [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8125rem] [&_code]:break-words [&_strong]:font-semibold [&_strong]:text-foreground">
      {blocks.map((b, i) =>
        b.kind === 'h' ? (
          <h2 key={i} id={headingId(b.text)} className="mt-8 scroll-mt-20 border-t pt-8 text-2xl font-semibold tracking-tight text-foreground first:mt-0 first:border-t-0 first:pt-0">{b.text}</h2>
        ) : b.kind === 'h3' ? (
          <h3 key={i} id={headingId(b.text)} className="mt-3 scroll-mt-20 text-lg font-semibold text-foreground">{b.text}</h3>
        ) : b.kind === 'ul' ? (
          <ul key={i} className="grid list-disc gap-2 pl-5 marker:text-muted-foreground">{b.items.map((item, j) => <li key={j} className="pl-1">{inline(item)}</li>)}</ul>
        ) : b.kind === 'ol' ? (
          <ol key={i} className="grid list-decimal gap-2 pl-5 marker:font-medium marker:text-muted-foreground">{b.items.map((item, j) => <li key={j} className="pl-1">{inline(item)}</li>)}</ol>
        ) : b.kind === 'img' ? (
          <figure key={i} className="my-2 grid gap-2">
            <img src={b.src} alt={b.alt} loading="lazy" className="w-full rounded-lg border bg-muted" />
            {b.alt && <figcaption className="text-center text-sm text-muted-foreground">{b.alt}</figcaption>}
          </figure>
        ) : b.kind === 'code' ? (
          <Code key={i} code={b.text} label={kind(b.text)} />
        ) : b.kind === 'note' ? (
          <Alert key={i} variant="info"><AlertDescription><p>{inline(b.text)}</p></AlertDescription></Alert>
        ) : (
          <p key={i}>{inline(b.text)}</p>
        ),
      )}
    </div>
  )
}
