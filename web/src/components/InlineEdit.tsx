import { message } from '@/lib/messages'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Pencil } from '@/components/icons'
import { cn } from '@/lib/utils'

/** A name edited where it is shown: click it (or `editing` from a menu), type, Enter or click away saves, Escape cancels.
 *  `onSave` returns a problem to show, or nothing when it worked. */
export function InlineEdit({ value, onSave, label, max = 200, className, editing, onEditingChange, disabled }: { value: string; onSave: (next: string) => Promise<string | void>; label: string; max?: number; className?: string; editing?: boolean; onEditingChange?: (on: boolean) => void; disabled?: boolean }) {
  const [own, setOwn] = useState(false)
  const on = editing ?? own
  const set = (v: boolean) => (onEditingChange ? onEditingChange(v) : setOwn(v))
  const [text, setText] = useState(value)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!on) return
    setText(value)
    setProblem('')
    input.current?.focus()
    input.current?.select()
  }, [on, value])

  async function save() {
    const next = text.trim()
    if (next === value) return set(false)
    if (!next || next.length > max) return setProblem(`Give it a name of up to ${max} characters.`)
    setBusy(true)
    try {
      const bad = await onSave(next)
      if (bad) setProblem(bad)
      else set(false)
    } catch (err) {
      setProblem(message(err)) // a callback that throws still frees the field and says why
    } finally {
      setBusy(false)
    }
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'Enter') void save()
    if (e.key === 'Escape') set(false)
  }

  if (!on)
    return (
      <button type="button" disabled={disabled} onClick={() => set(true)} aria-label={`${label}: ${value}. Edit`} className={cn('group/edit inline-flex max-w-full items-center gap-2 rounded-md text-left hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none', className)}>
        <span className="truncate">{value}</span>
        <Pencil className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100" />
      </button>
    )
  return (
    <span className="grid gap-1">
      <input ref={input} value={text} disabled={busy} maxLength={max + 20} aria-label={label} aria-invalid={problem ? true : undefined} onChange={(e) => setText(e.target.value)} onKeyDown={key} onBlur={() => void save()} className={cn('w-full min-w-0 rounded-md border border-input bg-background px-2 py-0.5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24', className)} />
      {problem && <span className="text-sm font-normal text-destructive">{problem}</span>}
    </span>
  )
}
