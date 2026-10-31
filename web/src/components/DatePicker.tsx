import { useState } from 'react'
import { CalendarCheck, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { dt } from '@/lib/format'
import { cn } from '@/lib/utils'

const shown = dt(undefined, { dateStyle: 'medium' })
const two = (n: number) => String(n).padStart(2, '0')
const toDay = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
const fromDay = (v: string) => new Date(`${v}T00:00`)

/** A day picked from a calendar. `value` and `min` are YYYY-MM-DD; '' is no day. */
export function DatePicker({ value, onChange, min, placeholder = 'Pick a date', label, id, className }: { value: string; onChange: (day: string) => void; min?: string; placeholder?: string; label?: string; id?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const selected = value ? fromDay(value) : undefined
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn('relative w-full', className)}>
        <PopoverTrigger render={<Button id={id} variant="outline" aria-label={label ?? placeholder} className={cn('w-full justify-start font-normal', !selected && 'text-muted-foreground')} />}>
          <CalendarCheck />
          {selected ? shown.format(selected) : placeholder}
        </PopoverTrigger>
        {selected && (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Clear the date" className="absolute inset-e-1.5 top-1/2 -translate-y-1/2" onClick={() => onChange('')}>
            <X />
          </Button>
        )}
      </div>
      <PopoverPopup align="start" className="w-auto p-2">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          disabled={min ? { before: fromDay(min) } : undefined}
          onSelect={(d) => {
            onChange(d ? toDay(d) : '')
            setOpen(false)
          }}
        />
      </PopoverPopup>
    </Popover>
  )
}

/** A span of days picked from one calendar: click the first day, then the last. Values are YYYY-MM-DD; '' is open-ended. */
export function DateRangePicker({ from, to, onChange, placeholder = 'Any dates', label, earliest, latest }: { from: string; to: string; onChange: (from: string, to: string) => void; placeholder?: string; label?: string; earliest?: Date; latest?: Date }) {
  const [open, setOpen] = useState(false)
  const selected = from || to ? { from: from ? fromDay(from) : undefined, to: to ? fromDay(to) : undefined } : undefined
  const text = selected ? `${selected.from ? shown.format(selected.from) : 'Any day'} – ${selected.to ? shown.format(selected.to) : 'Any day'}` : placeholder
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="relative w-full">
        <PopoverTrigger render={<Button variant="outline" aria-label={label ?? placeholder} className={cn('w-full justify-start font-normal', !selected && 'text-muted-foreground')} />}>
          <CalendarCheck />
          {text}
        </PopoverTrigger>
        {selected && (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Clear the dates" className="absolute inset-e-1.5 top-1/2 -translate-y-1/2" onClick={() => onChange('', '')}>
            <X />
          </Button>
        )}
      </div>
      <PopoverPopup align="start" className="w-auto p-2">
        <Calendar
          mode="range"
          selected={selected}
          defaultMonth={selected?.from}
          disabled={[...(earliest ? [{ before: earliest }] : []), ...(latest ? [{ after: latest }] : [])]}
          onSelect={(r) => {
            onChange(r?.from ? toDay(r.from) : '', r?.to ? toDay(r.to) : '')
            if (r?.from && r?.to && toDay(r.from) !== toDay(r.to)) setOpen(false)
          }}
        />
      </PopoverPopup>
    </Popover>
  )
}
