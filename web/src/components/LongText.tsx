import { useState } from 'react'
import { Copy } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { copy } from '@/lib/copy'
import { cn } from '@/lib/utils'

const LONG = 60

/** Text cut to one line; when it is long or has line breaks, a View button opens all of it. */
export function LongText({ text, label, className }: { text: string; label: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > LONG || text.includes('\n')
  return (
    <span className="inline-flex max-w-full items-center gap-2 align-middle">
      <span className={cn('min-w-0 truncate', className)}>{text.replace(/\s*\n\s*/g, ' ')}</span>
      {long && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto shrink-0 px-0"
          onClick={(e) => {
            e.stopPropagation()
            setOpen(true)
          }}
        >
          View
        </Button>
      )}
      {long && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup className="max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle>{label}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <pre className="max-h-[60vh] whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={() => void copy(text, label)}>
                <Copy />
                Copy
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </span>
  )
}
