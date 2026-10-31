import { useEffect, useRef, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { SlidersHorizontal } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Sheet, SheetClose, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { DateRangePicker } from '@/components/DatePicker'
import { Switch } from '@/components/ui/switch'
import { Select, SelectPopup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSetParams } from '@/hooks/use-set-params'

// A list's filters, kept in the URL (?q=&<select>=&from=&to=) so a filtered view can be linked and reloaded.
type Choice = { key: string; label: string; all: string; options: { value: string; label: string }[] }
type Toggle = { key: string; label: string; help?: string }
type Props = { search?: string; selects?: Choice[]; toggles?: Toggle[]; dates?: boolean; extra?: string[] }

// Dates are picked as days in this browser's time zone. "To" includes its day: it's sent as the start of the next.
const ALL = '__all' // Select items need a non-empty value
const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z')
const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

export function ListFilters({ search, selects = [], toggles = [], dates = false, extra = [] }: Props) {
  const set = useSetParams()
  const params = useSearch({ strict: false }) as Record<string, unknown>
  const param = (k: string) => (params[k] == null ? '' : String(params[k]))
  // Searching waits for a pause in typing.
  const [typed, setTyped] = useState(param('q'))
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  function type(v: string) {
    setTyped(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => set({ q: v.trim() }), 300)
  }
  const keys = [...(search ? ['q'] : []), ...selects.map((s) => s.key), ...toggles.map((t) => t.key), ...(dates ? ['from', 'to'] : []), ...extra]
  const narrowed = keys.some((k) => param(k))
  function clear() {
    setTyped('')
    set(Object.fromEntries(keys.map((k) => [k, ''])))
  }
  function day(k: string) {
    if (!param(k)) return ''
    const d = new Date(param(k))
    if (k === 'to') d.setDate(d.getDate() - 1)
    return local(d)
  }
  function setDays(f: string, t: string) {
    const end = t ? new Date(`${t}T00:00`) : null
    end?.setDate(end.getDate() + 1)
    set({ from: f ? iso(new Date(`${f}T00:00`)) : '', to: end ? iso(end) : '' })
  }
  const count = keys.filter((k) => param(k)).length
  // Only a search to offer: a box in the header is enough, no sheet.
  if (search && !selects.length && !toggles.length && !dates && !extra.length)
    return <Input type="search" value={typed} onChange={(e) => type(e.target.value)} placeholder={search} aria-label={search} autoComplete="off" className="w-56 sm:w-64" />
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" />}>
        <SlidersHorizontal />
        Filters
        {count > 0 && <Badge variant="secondary">{count}</Badge>}
      </SheetTrigger>
      <SheetPopup className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>The list updates as you choose.</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-4 [&_[data-slot=field]]:items-stretch">
          {search && (
          <Field>
            <FieldLabel>Search</FieldLabel>
            <Input value={typed} onChange={(e) => type(e.target.value)} placeholder={search} aria-label={search} autoComplete="off" />
          </Field>
          )}
          {selects.map((s) => (
            <Field key={s.key}>
              <FieldLabel>{s.label}</FieldLabel>
              <Select items={[{ value: ALL, label: s.all }, ...s.options]} value={param(s.key) || ALL} onValueChange={(v) => set({ [s.key]: !v || v === ALL ? '' : v })}>
                <SelectTrigger aria-label={s.label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL}>{s.all}</SelectItem>
                  {s.options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          ))}
          {dates && (
            <Field>
              <FieldLabel>Dates</FieldLabel>
              <DateRangePicker label="Dates" from={day('from')} to={day('to')} onChange={(f, t) => setDays(f, t)} />
            </Field>
          )}
          {toggles.map((t) => (
            <Field key={t.key} className="flex-row items-start gap-3">
              <Switch id={`flt-${t.key}`} checked={param(t.key) === 'true'} onCheckedChange={(on) => set({ [t.key]: on ? 'true' : '' })} />
              <FieldLabel htmlFor={`flt-${t.key}`}>{t.label}</FieldLabel>
            </Field>
          ))}
        </SheetPanel>
        <SheetFooter>
          <Button variant="ghost" disabled={!narrowed} onClick={clear}>
            Clear filters
          </Button>
          <SheetClose render={<Button />}>Done</SheetClose>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  )
}
