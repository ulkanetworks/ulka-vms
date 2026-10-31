import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** Page grid: content, plus the "On this page" column from xl up when there is one. */
export const docsPage = (toc: boolean) => cn('mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-8', toc && 'xl:max-w-5xl xl:grid-cols-[minmax(0,1fr)_14rem]')

// "On this page": links to the page's anchors, marking the one being read.
export function Toc({ items }: { items: { id: string; label: string; heading?: boolean }[] }) {
  const [active, setActive] = useState('')
  const key = items.map((i) => i.id).join('|')

  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((el): el is HTMLElement => el !== null)
    const seen = new Set<string>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) (e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id))
        setActive((a) => items.find((i) => seen.has(i.id))?.id ?? a)
      },
      { rootMargin: '-72px 0px -60% 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!items.length) return null
  return (
    <nav aria-label="On this page" className="sticky top-24 hidden max-h-[calc(100vh-6rem)] content-start gap-1 self-start overflow-y-auto text-sm xl:grid">
      <p className="font-medium">On this page</p>
      {items.map((i) => (
        <a key={i.id} href={`#${i.id}`} aria-current={active === i.id ? 'location' : undefined} className={cn('text-muted-foreground hover:text-foreground', i.heading && 'mt-3 text-xs font-medium tracking-wide text-foreground uppercase', active === i.id && 'font-medium text-foreground')}>
          {i.label}
        </a>
      ))}
    </nav>
  )
}
