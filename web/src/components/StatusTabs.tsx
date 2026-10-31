import type { IconComponent } from '@/components/icons'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { number } from '@/lib/format'

export type StatusTab = { value: string; label: string; count?: number; icon?: IconComponent }

/** A row of states to filter a list by, drawn as the same Tabs used everywhere else, each with its count. */
export function StatusTabs({ value, onChange, items, label }: { value: string; onChange: (value: string) => void; items: StatusTab[]; label: string }) {
  return (
    <Tabs className="max-w-full min-w-0" value={value} onValueChange={(v) => onChange(String(v))}>
      <TabsList aria-label={label} className="max-w-full justify-start overflow-x-auto">
        {items.map((i) => (
          <TabsTab key={i.value} value={i.value}>
            {i.icon && <i.icon aria-hidden />}
            {i.label}
            {i.count !== undefined && <span className="ml-1.5 font-mono text-xs text-muted-foreground tabular-nums">{number(i.count)}</span>}
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
  )
}
