import type { ReactNode } from 'react'
import { Bell } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'

// The header bell: a count of what needs attention, an amber dot while something special is on (a support session).
export function AlertsMenu({ count, warn, children }: { count: number; warn?: boolean; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon" className="relative" aria-label={count ? `Notifications, ${count} need attention` : warn ? 'Notifications, a support session is active' : 'Notifications'} />}>
        <Bell />
        {count > 0 && (
          <Badge variant="destructive" className="absolute -top-1 -right-1 h-4 min-w-4 px-1">
            {count > 9 ? '9+' : count}
          </Badge>
        )}
        {warn && <span aria-hidden="true" className="absolute right-1 bottom-1 size-2 rounded-full bg-amber-500 ring-2 ring-background" />}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[min(24rem,calc(100vw-2rem))]">
        <PopoverTitle className="mb-3 text-base">Notifications</PopoverTitle>
        <div className="grid max-h-96 gap-2 overflow-y-auto">{children}</div>
      </PopoverPopup>
    </Popover>
  )
}
