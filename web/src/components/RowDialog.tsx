import type { ReactNode } from 'react'
import { Facts, type Fact } from '@/components/Facts'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'

/** A quick view of one list row: every field as facts, with the row's actions in the foot. */
export function RowDialog({ title, subtitle, rows, footer, children, onClose }: { title: string; subtitle?: string; rows: Fact[]; footer?: ReactNode; children?: ReactNode; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate pe-8">{title}</DialogTitle>
          {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
        </DialogHeader>
        <DialogPanel>
          <Facts rows={rows} />
          {children}
        </DialogPanel>
        {footer && <DialogFooter variant="bare">{footer}</DialogFooter>}
      </DialogPopup>
    </Dialog>
  )
}
