import { useState } from 'react'
import * as v from 'valibot'
import * as schema from '@/lib/schemas'
import { api } from '@/lib/api'
import { FormDialog, Wizard } from '@/components/Wizard'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { rules } from '@/lib/rules'
import { message } from '@/lib/messages'
import { refresh } from '@/lib/query'
import { toast } from '@/lib/toast'

export type Endpoint = { id: string; name: string; url: string; events: string[]; enabled: boolean; created_at: string }

const Url = schema.address('invalid_url', { https: true, path: true, query: true })
const STEPS: [string, string][] = [
  ['Address', 'Where we send messages, and a name to tell it apart.'],
  ['Events', 'All events, or only the ones your app needs.'],
]

/** A webhook's events, in two groups: a video's life and CDN distributions. */
export const eventGroups = () => [
  { label: "A video's life", events: rules.webhook_events.filter((e) => !e.type.startsWith('cdn.') && !e.type.startsWith('live.')) },
  { label: 'CDN distributions', events: rules.webhook_events.filter((e) => e.type.startsWith('cdn.')) },
  { label: 'Live', events: rules.webhook_events.filter((e) => e.type.startsWith('live.')) },
]

/** Adds an endpoint (then onCreated gets its one-time secret) or changes one. */
export function WebhookForm({ open, onOpenChange, editing, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; editing: Endpoint | null; onCreated: (secret: string) => void }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(editing?.name ?? '')
  const [url, setUrl] = useState(editing?.url ?? '')
  const [some, setSome] = useState(!!editing?.events.length)
  const [events, setEvents] = useState<string[]>(editing?.events ?? [])
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    const body = { name: name.trim(), url: url.trim(), events: some ? events : [] }
    try {
      if (editing) {
        await api('PATCH', `/v1/webhook-endpoints/${editing.id}`, body)
        toast('Saved.')
      } else {
        onCreated((await api<{ secret: string }>('POST', '/v1/webhook-endpoints', body)).secret)
        toast('Address added.')
      }
      await refresh('/v1/webhook-endpoints')
      onOpenChange(false)
    } catch (err) {
      toast(message(err), 'danger')
    } finally {
      setBusy(false)
    }
  }
  function next() {
    if (step === 0) {
      const p = schema.check(v.object({ name: schema.optionalName(), url: Url }), { name, url })
      setProblems(p)
      if (!Object.keys(p).length) setStep(1)
      return
    }
    if (some && events.length === 0) return setProblems({ events: 'Choose at least one event, or every event.' })
    void save()
  }

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} busy={busy} title={editing ? 'Change webhook address' : 'Add a webhook address'} description="Your app gets a message the moment something happens. If it doesn't reply OK (a 2xx code), we try again for 24 hours.">
      <Wizard steps={STEPS} step={step} onNext={next} onBack={() => setStep(0)} busy={busy} finish={editing ? 'Save' : 'Add address'}
        unchanged={!!editing && name.trim() === editing.name && url.trim() === editing.url && (some ? [...events].sort().join() : '') === [...editing.events].sort().join()}>
        {step === 0 ? (
          <>
            <Field invalid={!!problems.url}>
              <FieldLabel htmlFor="wh-url">Address</FieldLabel>
              <Input id="wh-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/ulka" aria-invalid={!!problems.url || undefined} />
              {problems.url ? <FieldError>{problems.url}</FieldError> : <FieldDescription>A page on your own server that accepts our messages.</FieldDescription>}
            </Field>
            <Field invalid={!!problems.name}>
              <FieldLabel htmlFor="wh-name">Name (optional)</FieldLabel>
              <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing app" maxLength={100} aria-invalid={!!problems.name || undefined} />
              {problems.name && <FieldError>{problems.name}</FieldError>}
            </Field>
          </>
        ) : (
          <>
            <RadioGroup value={some ? 'some' : 'all'} onValueChange={(v) => (setSome(v === 'some'), setProblems({}))} aria-label="Which events">
              <Field className="flex-row items-start gap-3">
                <RadioGroupItem value="all" id="wh-all" />
                <div className="grid gap-1">
                  <FieldLabel htmlFor="wh-all">All events</FieldLabel>
                  <FieldDescription>Including ones we add later.</FieldDescription>
                </div>
              </Field>
              <Field className="flex-row items-start gap-3">
                <RadioGroupItem value="some" id="wh-some" />
                <FieldLabel htmlFor="wh-some">Only the ones I choose</FieldLabel>
              </Field>
            </RadioGroup>
            {some && (
              <div className="grid gap-4 sm:grid-cols-2">
                {eventGroups().map((g) => (
                  <fieldset key={g.label} className="grid content-start gap-2">
                    <legend className="mb-1 text-sm font-medium">{g.label}</legend>
                    {g.events.map((e) => (
                      <Field key={e.type} className="flex-row items-start gap-2">
                        <Checkbox id={`wh-${e.type}`} checked={events.includes(e.type)} onCheckedChange={(c) => (setEvents(c === true ? [...events, e.type] : events.filter((x) => x !== e.type)), setProblems({}))} />
                        <FieldLabel htmlFor={`wh-${e.type}`} className="font-normal">{e.words}</FieldLabel>
                      </Field>
                    ))}
                  </fieldset>
                ))}
              </div>
            )}
            {problems.events && <p className="text-sm text-destructive-foreground">{problems.events}</p>}
          </>
        )}
      </Wizard>
    </FormDialog>
  )
}
