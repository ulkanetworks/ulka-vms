import type { ComponentProps, ReactNode } from 'react'
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from '@/components/ui/frame'
import { cn } from '@/lib/utils'

type Props = Omit<ComponentProps<'div'>, 'title'> & {
  title?: ReactNode
  description?: ReactNode
  /** Buttons or a switch at the top right of the header. */
  action?: ReactNode
  footer?: ReactNode
  /** The body reaches the edges: a table or a list of rows. */
  flush?: boolean
  /** Children are the card's own contents (a card table, several `Panel`s), not wrapped in one panel. */
  bare?: boolean
  bodyClassName?: string
}

/** Every card on every page: header (title, description, action at the top right), one body, an optional footer. */
export function Section({ title, description, action, footer, flush, bare, bodyClassName, className, children, ...rest }: Props) {
  return (
    <Frame className={className} {...rest}>
      {(title || description || action) && (
        <FrameHeader className="flex-row items-start justify-between gap-4">
          <div className="grid min-w-0 gap-0.5">
            {title && <FrameTitle className="flex flex-wrap items-center gap-2">{title}</FrameTitle>}
            {description && <FrameDescription>{description}</FrameDescription>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </FrameHeader>
      )}
      {bare ? children : children != null && children !== false && <FramePanel className={cn('flex-1', flush && 'p-0', bodyClassName)}>{children}</FramePanel>}
      {footer && <FrameFooter className="py-3">{footer}</FrameFooter>}
    </Frame>
  )
}

/** A second body in a `bare` Section. */
export const Panel = FramePanel
/** A strip under a `bare` Section's body (a table's pager). */
export const Footer = FrameFooter

const COLS = { 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3' }

/** Sections side by side: each row's headers share one height, so their bodies start level and end level. */
export function Sections({ cols = 2, className, ...rest }: ComponentProps<'div'> & { cols?: 2 | 3 }) {
  return (
    <div
      className={cn(
        // min-w-0 and one-column frames: a long title truncates instead of pushing its card past the column.
        'grid grid-cols-1 gap-4 *:min-w-0 lg:auto-rows-[auto_1fr]',
        COLS[cols],
        'lg:*:data-[slot=frame]:row-span-2 lg:*:data-[slot=frame]:grid lg:*:data-[slot=frame]:grid-cols-1 lg:*:data-[slot=frame]:grid-rows-subgrid lg:*:data-[slot=frame]:gap-y-0',
        'lg:*:data-[slot=frame]:*:data-[slot=frame-panel]:row-start-2',
        className,
      )}
      {...rest}
    />
  )
}
