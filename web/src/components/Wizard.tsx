import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ArrowLeft, Check } from '@/components/icons'
import { Dialog, DialogClose, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from '@/components/ui/dialog'

type Props = {
  /** Each step's title and one sentence on what it asks, shown up front so people know what is coming. */
  steps: [title: string, hint: string][]
  step: number // zero-based
  /** Called by Continue and by Enter. Validate here; move on with setStep, or do the final work on the last step. */
  onNext: () => void
  onBack: () => void
  busy?: boolean
  finish: string // the last step's button, e.g. "Create distribution"
  /** Editing something that hasn't changed: the last step's button stays off, so nothing is saved for no reason. */
  unchanged?: boolean
  children: ReactNode
}

/** A form asked one step at a time: the steps down a rail on the left (hidden on phones), the current one's title, hint and
 * fields on the right, Back and Continue below. The parent owns the answers and the step. */
export function Wizard({ steps, step, onNext, onBack, busy, finish, unchanged, children }: Props) {
  const last = step === steps.length - 1
  const body = useRef<HTMLDivElement>(null)
  // Each step starts with its first field focused, so Enter keeps going.
  useEffect(() => void body.current?.querySelector<HTMLElement>('input, textarea, button[role=combobox], button[role=switch]')?.focus(), [step])
  const [title, hint] = steps[step]
  return (
    <form noValidate className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] border-t md:grid-cols-[20rem_minmax(0,1fr)]" onSubmit={(e) => { e.preventDefault(); onNext() }}>
      <ol className="hidden flex-col overflow-y-auto border-e bg-muted/40 p-6 md:flex">
        {steps.map(([t, h], i) => (
          <li key={t} className="relative flex gap-3 pb-6 last:pb-0" aria-current={i === step ? 'step' : undefined}>
            {i < steps.length - 1 && <span aria-hidden className="absolute start-3 top-7 bottom-1 w-px -translate-x-1/2 bg-border" />}
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums ${i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-primary/15 text-primary' : 'border bg-background text-muted-foreground'}`}>
              {i < step ? <Check className="size-3.5" /> : i + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
              <span className={`text-sm font-medium ${i > step ? 'text-muted-foreground' : ''}`}>{t}</span>
              <span className="text-xs text-muted-foreground">{h}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex flex-col gap-1 px-6 pt-5 pb-4 md:hidden">
          <span className="text-xs text-muted-foreground">
            Step <span className="font-medium text-foreground tabular-nums">{step + 1}</span>/{steps.length}
          </span>
          <span className="font-medium">{title}</span>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        <div ref={body} className="flex min-h-72 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6 md:px-8 md:pt-6">{children}</div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t px-6 py-4 md:col-span-2">
        <DialogClose render={<Button type="button" variant="ghost" disabled={busy} />}>Cancel</DialogClose>
        {step > 0 && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
            <ArrowLeft />
            Back
          </Button>
        )}
        <Button type="submit" disabled={busy || (last && unchanged)}>
          {busy && <Spinner />}
          {last ? finish : 'Continue'}
        </Button>
      </div>
    </form>
  )
}

/** The shell every form dialog shares: title, one plain sentence, and a close that is ignored while busy. */
export function FormDialog({ open, onOpenChange, busy, title, description, children }: { open: boolean; onOpenChange: (o: boolean) => void; busy?: boolean; title: string; description: string; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(o) => (o || !busy) && onOpenChange(o)}>
      <DialogPopup className="sm:max-w-3xl sm:has-[table]:max-w-4xl">
        {/* A step showing a table (a review) gets the wider dialog; forms keep a comfortable width. */}
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogPopup>
    </Dialog>
  )
}
