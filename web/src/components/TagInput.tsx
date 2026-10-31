import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { X } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import type { Check } from '@/lib/tags'

/** max is the API's limit for this list, from rules.limits. */
type Props = { label: string; value: string[]; onChange: (v: string[]) => void; check: Check; max: number; placeholder?: string; hint?: string }

export function TagInput({ label, value, onChange, check, max, placeholder, hint }: Props) {
  const id = useId()
  const [text, setText] = useState('')
  const [problem, setProblem] = useState('')
  const input = useRef<HTMLInputElement>(null)

  // Adds each entry in text (pasted lists split on spaces, commas and lines); a bad one stays in the box to fix.
  function commit(raw = text) {
    const entries = raw.split(/[\s,;]+/).filter(Boolean)
    const next = [...value]
    for (const [i, entry] of entries.entries()) {
      const r = check(entry)
      const bad = 'problem' in r ? r.problem : next.length >= max ? `At most ${max}.` : ''
      if (bad) {
        setProblem(bad)
        setText(entries.slice(i).join(' '))
        onChange(next)
        return
      }
      if ('value' in r && !next.includes(r.value)) next.push(r.value)
    }
    onChange(next)
    setText('')
    setProblem('')
  }
  function onKeyDown(e: KeyboardEvent) {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ' ' || e.key === 'Tab') && text.trim()) {
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
  }
  function onPaste(e: ClipboardEvent) {
    const pasted = e.clipboardData.getData('text')
    if (/[\s,;]/.test(pasted.trim())) {
      e.preventDefault()
      commit(text + pasted)
    }
  }
  return (
    <Field invalid={!!problem}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        {value.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap">
            {value.map((v) => (
              <Badge key={v} variant="secondary" className="pr-0.5 font-mono">
                {v}
                <Button type="button" variant="ghost" size="icon" className="size-4" aria-label={`Remove ${v}`} onClick={() => (onChange(value.filter((x) => x !== v)), input.current?.focus())}>
                  <X />
                </Button>
              </Badge>
            ))}
          </InputGroupAddon>
        )}
        <InputGroupInput
          id={id}
          ref={input}
          value={text}
          onChange={(e) => (setText(e.target.value), setProblem(''))}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => text.trim() && commit()}
          placeholder={value.length ? '' : placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={(!!problem) ? true : undefined}
          className="font-mono"
        />
      </InputGroup>
      {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>{hint || 'Press Enter after each one.'}</FieldDescription>}
    </Field>
  )
}
