import { useState } from 'react'
import * as v from 'valibot'
import * as schema from '@/lib/schemas'
import { api } from '@/lib/api'
import { message } from '@/lib/messages'
import { refresh } from '@/lib/query'
import { toast } from '@/lib/toast'
import { FolderChoice } from '@/components/library/FolderPicker'
import { FormDialog, Wizard } from '@/components/Wizard'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export const FolderSchema = v.object({
  name: schema.name(),
})

function Form({ lib, parent, onClose }: { lib: string; parent: string | null; onClose: () => void }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [dest, setDest] = useState(parent)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      await api('POST', `/v1/libraries/${lib}/folders`, { name: name.trim(), ...(dest ? { parent_id: dest } : {}) })
      await refresh('/v1/libraries')
      toast('Folder created.')
      onClose()
    } catch (err) {
      toast(message(err), 'danger')
      setBusy(false)
    }
  }
  function next() {
    if (step === 0) {
      const p = schema.check(FolderSchema, { name })
      setProblem(p.name ?? '')
      if (!p.name) setStep(1)
    } else void create()
  }
  return (
    <Wizard steps={[['Name', 'What the folder is called.'], ['Where it goes', 'The folder to put it in.']]} step={step} onNext={next} onBack={() => setStep(0)} busy={busy} finish="Create folder">
      {step === 0 ? (
        <Field invalid={!!problem}>
          <FieldLabel htmlFor="folder-name">Name</FieldLabel>
          <Input id="folder-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Lessons" aria-invalid={!!problem || undefined} />
          {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>Videos can be moved into it afterwards.</FieldDescription>}
        </Field>
      ) : (
        <FolderChoice lib={lib} onLib={() => {}} dest={dest} onDest={setDest} top="Top of the library" />
      )}
    </Wizard>
  )
}

/** The "Create folder" dialog: a name, then the folder it goes in (the one you are in is chosen to begin with). */
export function NewFolder({ open, onOpenChange, lib, parent }: { open: boolean; onOpenChange: (o: boolean) => void; lib: string; parent: string | null }) {
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Create folder" description="Folders keep the videos of a library tidy.">
      <Form lib={lib} parent={parent} onClose={() => onOpenChange(false)} />
    </FormDialog>
  )
}
