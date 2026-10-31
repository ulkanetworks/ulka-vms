import { useState } from 'react'
import * as v from 'valibot'
import * as schema from '@/lib/schemas'
import { api } from '@/lib/api'
import { message } from '@/lib/messages'
import { refresh } from '@/lib/query'
import { rules } from '@/lib/rules'
import { toast } from '@/lib/toast'
import { ipRange } from '@/lib/tags'

const keyRange = ipRange('invalid_ip_range')
import { Code } from '@/components/Code'
import { CopyButton } from '@/components/CopyButton'
import { DatePicker } from '@/components/DatePicker'
import { TagInput } from '@/components/TagInput'
import { FormDialog, Wizard } from '@/components/Wizard'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'

type Level = 'none' | 'read' | 'write'
const LEVELS: { id: Level; name: string }[] = [
  { id: 'none', name: 'None' },
  { id: 'read', name: 'Read' },
  { id: 'write', name: 'Read & write' },
]
const TITLES: [string, string][] = [
  ['Name', 'A name so you can tell your keys apart.'],
  ['What it can do', 'Which products the key may read or change.'],
  ['Limits', 'Optional: the addresses it works from, and a date it stops working.'],
]
const blank = (): Record<string, Level> => Object.fromEntries(rules.products.map((p) => [p.id, 'none']))
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)

function Form({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0)
  const [access, setAccess] = useState(blank)
  const [ips, setIps] = useState<string[]>([])
  const [limitIps, setLimitIps] = useState(false)
  const [expires, setExpires] = useState('')
  const [expiresOn, setExpiresOn] = useState(false)
  const [name, setName] = useState('')
  const [problem, setProblem] = useState('')
  const [created, setCreated] = useState('')
  const [busy, setBusy] = useState(false)
  const scopes = Object.entries(access).filter(([, l]) => l !== 'none').map(([p, l]) => `${p}:${l}`)

  async function create() {
    setBusy(true)
    try {
      // The key stops working at the start of the chosen day, in this browser's time zone.
      const expires_at = expiresOn && expires ? new Date(expires + 'T00:00').toISOString() : null
      setCreated((await api<{ key: string }>('POST', '/v1/api-keys', { name: name.trim(), scopes, allowed_ips: limitIps ? ips : [], expires_at })).key)
      void refresh('/v1/api-keys')
    } catch (err) {
      toast(message(err), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const next = () => {
    if (step === 0) {
      const r = v.safeParse(schema.name(), name)
      setProblem(r.success ? '' : r.issues[0].message)
      if (!r.success) return
    }
    if (step === 1) {
      setProblem(scopes.length ? '' : 'Choose at least one product the key can use.')
      if (!scopes.length) return
    }
    if (step === 2 && expiresOn && !expires) {
      setProblem('Choose the day it stops working, or turn this off.')
      return
    }
    if (step < TITLES.length - 1) setStep(step + 1)
    else void create()
  }

  if (created)
    return (
      <>
        <div className="flex flex-col gap-3 px-6 pt-1 pb-4">
          <p className="text-sm font-medium">Your key is ready. Copy it now and keep it somewhere safe: it is shown once and cannot be retrieved again.</p>
          <InputGroup>
            <InputGroupInput readOnly autoFocus value={created} aria-label="API key" className="font-mono" />
            <InputGroupAddon align="inline-end">
              <CopyButton value={created} what="API key" />
            </InputGroupAddon>
          </InputGroup>
          <p className="text-sm text-muted-foreground">Try it from a terminal (it works if the key can read Video):</p>
          <Code label="List your videos" code={`curl ${location.origin}/v1/assets \\\n  -H "Authorization: Bearer ${created}"`} />
        </div>
        <div className="flex justify-end border-t px-6 py-4">
          <Button onClick={onClose}>I've saved it</Button>
        </div>
      </>
    )

  return (
    <Wizard steps={TITLES} step={step} onNext={next} onBack={() => { setProblem(''); setStep(step - 1) }} busy={busy} finish="Create key">
      {step === 0 && (
        <Field invalid={!!problem}>
          <FieldLabel htmlFor="key-name">Name</FieldLabel>
          <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production server" aria-invalid={!!problem || undefined} />
          {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>A label only you see, such as the server that will use it.</FieldDescription>}
        </Field>
      )}
      {step === 1 && (
        <fieldset className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">Choose Read to only look at things, Read &amp; write to also change or delete them. Pick the least you need: a leaked read-only key can't delete anything.</p>
          {rules.products.map((p) => (
            <Field key={p.id} className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="grid gap-0.5 text-sm">
                <strong>{p.name}</strong>
                <span className="text-xs text-muted-foreground">{access[p.id] === 'write' ? p.write : access[p.id] === 'read' ? p.read : 'No access'}</span>
              </div>
              <RadioGroup value={access[p.id]} onValueChange={(l) => setAccess((a) => ({ ...a, [p.id]: l as Level }))} aria-label={`${p.name} access`} className="w-auto flex-row gap-4">
                {LEVELS.map((l) => (
                  <Field key={l.id} className="w-auto flex-row items-center gap-2">
                    <RadioGroupItem value={l.id} id={`access-${p.id}-${l.id}`} />
                    <FieldLabel htmlFor={`access-${p.id}-${l.id}`} className="font-normal">{l.name}</FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </Field>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="link" size="sm" onClick={() => setAccess(Object.fromEntries(rules.products.map((p) => [p.id, 'write'])))}>Full access</Button>
            <Button type="button" variant="link" size="sm" onClick={() => setAccess(blank())}>Clear</Button>
          </div>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
        </fieldset>
      )}
      {step === 2 && (
        <>
          <p className="text-sm text-muted-foreground">Both are optional. Skip this step for a key that works from anywhere until you revoke it.</p>
          <Field className="flex-row items-start gap-3">
            <Switch id="key-limit-ips" checked={limitIps} onCheckedChange={setLimitIps} />
            <div className="grid gap-1">
              <FieldLabel htmlFor="key-limit-ips">Only work from my servers' addresses</FieldLabel>
              <FieldDescription>Off: the key works from anywhere. Turn on if your servers have fixed addresses, so a stolen key is useless elsewhere.</FieldDescription>
            </div>
          </Field>
          {limitIps && <TagInput label="Allowed addresses" value={ips} onChange={setIps} check={keyRange} max={rules.limits.key_ips} placeholder="203.0.113.7 or 198.51.100.0/24" hint="Your servers' IP addresses. A range like 198.51.100.0/24 covers a whole block of addresses." />}
          <Field className="flex-row items-start gap-3">
            <Switch id="key-expiry" checked={expiresOn} onCheckedChange={setExpiresOn} />
            <div className="grid gap-1">
              <FieldLabel htmlFor="key-expiry">Stop working on a date</FieldLabel>
              <FieldDescription>Off: the key works until you revoke it. Turn on for temporary access, such as a contractor.</FieldDescription>
            </div>
          </Field>
          {expiresOn && (
            <Field invalid={!!problem}>
              <FieldLabel htmlFor="key-expires">Expires on</FieldLabel>
              <DatePicker id="key-expires" min={tomorrow} value={expires} onChange={(d) => (setExpires(d), setProblem(''))} className="w-56" />
              {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>It stops working at the start of that day.</FieldDescription>}
            </Field>
          )}
        </>
      )}
    </Wizard>
  )
}

/** The "New API key" dialog: name, access, limits; the secret is shown once in the same dialog afterwards. */
export function NewApiKey({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="New API key" description="A key is a password for your own software. Make one per server and give it only the access that server needs.">
      <Form onClose={() => onOpenChange(false)} />
    </FormDialog>
  )
}
