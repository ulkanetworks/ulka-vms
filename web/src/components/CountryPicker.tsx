import { useId, useMemo, useState } from 'react'
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxValue } from '@/components/ui/combobox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { COUNTRIES, countryName, type Country } from '@/lib/countries'

/** Pick countries by name; the value is their two-letter codes. max is the API's limit, from rules.limits. */
export function CountryPicker({ label, value, onChange, max, hint }: { label: string; value: string[]; onChange: (v: string[]) => void; max: number; hint?: string }) {
  const id = useId()
  const [query, setQuery] = useState('')
  // A typed code (US) first, then names starting with the text (India before British Indian Ocean Territory), then the rest.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return COUNTRIES
    const rank = (c: Country) => (c.value.toLowerCase() === q ? 0 : c.label.toLowerCase().startsWith(q) ? 1 : c.label.toLowerCase().includes(q) ? 2 : 3)
    return COUNTRIES.filter((c) => rank(c) < 3).sort((a, b) => rank(a) - rank(b))
  }, [query])
  // Saved codes the list doesn't know (set through the API) still show and can be removed.
  const selected = useMemo(() => value.map((code) => COUNTRIES.find((c) => c.value === code) ?? { value: code, label: countryName(code) }), [value])
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox items={shown} filter={null} inputValue={query} onInputValueChange={setQuery} autoHighlight multiple value={selected}
        isItemEqualToValue={(a: Country, b: Country) => a.value === b.value}
        // Base UI clears every pick on Escape with the list closed; people press it to close the list, so it's ignored.
        onValueChange={(next: Country[], details: { reason: string }) => details.reason !== 'escape-key' && onChange(next.slice(0, max).map((c) => c.value))}>
        <ComboboxChips>
          <ComboboxValue>
            {(chosen: Country[]) => (
              <>
                {chosen.map((c) => <ComboboxChip key={c.value} aria-label={c.label}>{c.label}</ComboboxChip>)}
                <ComboboxChipsInput id={id} placeholder={chosen.length ? undefined : 'Type a country’s name'} />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxPopup>
          <ComboboxEmpty>No country by that name.</ComboboxEmpty>
          <ComboboxList>
            {(c: Country) => (
              <ComboboxItem key={c.value} value={c}>
                {c.label} <span className="ms-auto font-mono text-muted-foreground text-xs">{c.value}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  )
}
