import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { copy } from '@/lib/copy'

/** The one copy button: an icon that turns into a check for a moment, and ignores clicks meanwhile. */
export function CopyButton({ value, what, className }: { value: string; what: string; className?: string }) {
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function click() {
    if (done || !(await copy(value, what[0].toUpperCase() + what.slice(1)))) return
    setDone(true)
    timer.current = setTimeout(() => setDone(false), 1600)
  }
  return (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={done ? `${what} copied` : `Copy ${what}`} aria-disabled={done} className={className ?? 'shrink-0 text-muted-foreground'} onClick={() => void click()}>
      {done ? <Check /> : <Copy />}
    </Button>
  )
}
