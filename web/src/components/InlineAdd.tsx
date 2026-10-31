import { message } from '@/lib/messages'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

/** A one-field add form in the page: input and button on a row. `onAdd` returns a problem to show, `false` to keep the text (it already told the user why), or nothing when it worked. */
export function InlineAdd({ label, placeholder, button, onAdd, onCancel, type, hint, busy: outer }: { label: string; placeholder?: string; button: string; onAdd: (text: string) => Promise<string | false | void>; onCancel?: () => void; type?: string; hint?: string; busy?: boolean }) {
  const [text, setText] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    setBusy(true)
    try {
      const r = await onAdd(text.trim())
      setProblem(r || '')
      if (r === undefined) setText('')
    } catch (err) {
      setProblem(message(err)) // a callback that throws still frees the button and says why
    } finally {
      setBusy(false)
    }
  }
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <Field invalid={!!problem}>
        <div className="flex flex-wrap items-start gap-2">
          <Input autoFocus type={type} aria-label={label} className="max-w-sm min-w-48 flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-invalid={!!problem || undefined} />
          <div className="ml-auto flex gap-2">
            {onCancel && <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>}
            <Button type="submit" disabled={busy || outer}>
              {busy && <Spinner />}
              {button}
            </Button>
          </div>
        </div>
        {problem ? <FieldError>{problem}</FieldError> : hint && <FieldDescription>{hint}</FieldDescription>}
      </Field>
    </form>
  )
}
