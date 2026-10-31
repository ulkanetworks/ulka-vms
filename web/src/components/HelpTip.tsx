import type { ReactNode } from 'react'
import { CircleQuestionMark } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'

/** A ? beside a title that opens a short explanation, so the page itself stays short. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} />}>
        <CircleQuestionMark />
      </PopoverTrigger>
      <PopoverPopup role="note" className="w-80 text-sm text-muted-foreground">{children}</PopoverPopup>
    </Popover>
  )
}
