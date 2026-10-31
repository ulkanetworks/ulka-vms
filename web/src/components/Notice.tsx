import { useState, type ReactNode } from 'react'
import { ChevronDown, TriangleAlert } from '@/components/icons'
import { AppLink } from '@/components/AppLink'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

export type NoticeItem = { key: string; text: ReactNode; href?: string; action?: string }

const read = (id: string) => {
  try {
    return sessionStorage.getItem(`notice:${id}`) === 'open'
  } catch {
    return false
  }
}

// One collapsed line for a banner-like list; open it to see every item. The choice is kept per notice for the session.
export function Notice({ id, title, tone = 'warning', items }: { id: string; title: string; tone?: 'danger' | 'warning' | 'info'; items: NoticeItem[] }) {
  const [open, setOpen] = useState(() => read(id))
  if (items.length === 0) return null
  const toggle = (next: boolean) => {
    setOpen(next)
    try {
      sessionStorage.setItem(`notice:${id}`, next ? 'open' : 'closed')
    } catch {
      // Not remembered; it still opens and closes.
    }
  }
  return (
    <Alert variant={tone === 'danger' ? 'error' : tone === 'info' ? 'info' : 'warning'} className="block p-0" role="status">
      <Collapsible open={open} onOpenChange={toggle}>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm">
          <TriangleAlert className={cn('size-4 shrink-0', tone === 'danger' ? 'text-destructive' : tone === 'info' ? 'text-info' : 'text-warning')} />
          <span className="shrink-0 font-medium text-foreground">{title}</span>
          <Badge variant="outline" size="sm" className="shrink-0">{items.length}</Badge>
          {!open && items.length === 1 && <span className="min-w-0 flex-1 truncate text-muted-foreground">{items[0].text}</span>}
          <ChevronDown className="ml-auto size-4 shrink-0 opacity-60 transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ul className="grid grid-cols-1 gap-1.5 px-3.5 pb-3 pl-9.5 text-sm text-muted-foreground">
            {items.map((i) => (
              <li key={i.key} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate" title={typeof i.text === 'string' ? i.text : undefined}>{i.text}</span>
                {i.href && <AppLink href={i.href} className="shrink-0 font-medium text-foreground underline underline-offset-2">{i.action ?? 'Open'}</AppLink>}
              </li>
            ))}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
    </Alert>
  )
}
