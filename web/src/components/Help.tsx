import type { ReactNode } from 'react'
import { CircleQuestionMark } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'

// A small question mark next to a control; the guidance a first-time user needs opens from it.
export function Help({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label={label} />}>
        <CircleQuestionMark />
      </PopoverTrigger>
      <PopoverPopup role="note" className="w-72 text-sm text-muted-foreground">{children}</PopoverPopup>
    </Popover>
  )
}
