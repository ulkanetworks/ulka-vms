import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

/** Discard and Save at a card's top right, hidden (not removed, so nothing moves) until something differs from what is saved. */
export function SaveBar({ dirty, saving, onSave, onDiscard, form }: { dirty: boolean; saving: boolean; onSave?: () => void; onDiscard: () => void; form?: string }) {
  const idle = !dirty && !saving
  return (
    <div className={cn('flex items-center gap-2', idle && 'invisible')} aria-hidden={idle || undefined}>
      <Button variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>Discard</Button>
      <Button size="sm" disabled={saving} type={form ? 'submit' : 'button'} form={form} onClick={onSave}>{saving && <Spinner />}Save</Button>
    </div>
  )
}
