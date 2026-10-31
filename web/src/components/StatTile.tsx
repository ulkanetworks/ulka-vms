import type { ReactNode } from 'react'
import { AppLink } from '@/components/AppLink'
import { CircleQuestionMark } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { Section } from '@/components/Section'

/** One headline figure: a label, the figure on one line (cut with an ellipsis, full text on hover) and a foot line that always takes its place, so tiles in a row line up. */
export function StatTile({ label, value, foot, href, badge, help }: { label: string; value: ReactNode; foot?: string; href?: string; badge?: ReactNode; help?: string }) {
  const phrase = typeof value === 'string' && value.length > 14
  return (
    <Section
      className="h-full min-w-0"
      bodyClassName="grid grid-cols-1 gap-1"
      footer={
        <p className="truncate text-sm text-muted-foreground" title={foot}>
          {foot || ' '}
        </p>
      }
    >
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span className="flex min-w-0 items-center">
            <span className="truncate" title={label}>
              {href ? (
                <AppLink href={href} className="hover:underline">
                  {label}
                </AppLink>
              ) : (
                label
              )}
            </span>
            {help && (
              <Popover>
                <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`What is ${label}?`} />}>
                  <CircleQuestionMark />
                </PopoverTrigger>
                <PopoverPopup role="note" className="w-72 text-sm text-muted-foreground">
                  {help}
                </PopoverPopup>
              </Popover>
            )}
          </span>
          {badge && <span className="shrink-0">{badge}</span>}
        </div>
        {/* A figure stays on one line; a phrase (Straight from Ulka VMS) is smaller and may take two lines. */}
        <p className={cn('flex min-h-9 items-center font-semibold', phrase ? 'line-clamp-2 text-lg leading-tight' : 'truncate text-3xl font-sans [font-variant-numeric:tabular-nums]')} title={typeof value === 'string' ? value : undefined}>
          {value}
        </p>
    </Section>
  )
}

/** The row of tiles: two across on small screens, four on wide ones. */
export function StatTiles({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
}
