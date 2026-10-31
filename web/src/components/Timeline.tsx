import type { ReactNode } from 'react'
import { dt } from '@/lib/format'
import { cn } from '@/lib/utils'

export type TimelineTone = 'success' | 'danger' | 'warning' | 'neutral'
/** `at` (a time) lets the list group entries under day headings when `byDay` is set. */
export type TimelineItem = { key: string; tone: TimelineTone; title: ReactNode; time?: ReactNode; at?: string | number; children?: ReactNode }

const DOT: Record<TimelineTone, string> = { success: 'bg-emerald-500', danger: 'bg-red-500', warning: 'bg-amber-500 animate-pulse', neutral: 'bg-muted-foreground/50' }
const day = dt(undefined, { dateStyle: 'short' })
const dayKey = (t: string | number) => day.format(new Date(t))
const weekday = dt(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

// Today and yesterday by name (in the viewer's zone), older days by date.
function dayLabel(t: string | number) {
  const key = dayKey(t)
  const name = key === dayKey(Date.now()) ? rel.format(0, 'day') : key === dayKey(Date.now() - 86_400_000) ? rel.format(-1, 'day') : weekday.format(new Date(t))
  return name[0].toUpperCase() + name.slice(1)
}

/** Things that happened, in order: a dot per entry on a vertical line, a title with its time at the right, and room for detail below. */
export function Timeline({ items, byDay = false }: { items: TimelineItem[]; byDay?: boolean }) {
  return (
    <ol className="grid gap-0">
      {items.map((it, i) => {
        const newDay = byDay && it.at !== undefined && (i === 0 || items[i - 1].at === undefined || dayKey(items[i - 1].at!) !== dayKey(it.at))
        return (
          <li key={it.key} className="contents">
            {newDay && <p className={cn('pb-3 text-xs font-medium text-muted-foreground', i > 0 && 'pt-2')}>{dayLabel(it.at!)}</p>}
            <div className={cn("relative grid grid-cols-[1.25rem_1fr] gap-x-3", i < items.length - 1 && "pb-5")}>
              {i < items.length - 1 && <span aria-hidden="true" className="absolute top-5 bottom-0 left-[0.5rem] w-px bg-border" />}
              <span aria-hidden="true" className={cn('mt-1.5 size-2.5 justify-self-center rounded-full ring-4 ring-background', DOT[it.tone])} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 font-semibold">{it.title}</div>
                  {it.time && <span className="ml-auto text-sm font-normal text-muted-foreground">{it.time}</span>}
                </div>
                {it.children && <div className="mt-1 grid gap-1.5 text-sm">{it.children}</div>}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
