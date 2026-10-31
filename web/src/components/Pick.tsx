import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'

type Props = { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; id?: string; label?: string; className?: string }

// A single-choice dropdown made of coss Select parts.
export function Pick({ value, onChange, options, id, label, className }: Props) {
  return (
    <Select items={options} value={value} onValueChange={(v) => v != null && onChange(v)}>
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}
