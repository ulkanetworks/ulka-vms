import { useState } from 'react'
import * as v from 'valibot'
import { Facts, type Fact } from '@/components/Facts'
import { HelpTip } from '@/components/HelpTip'
import { Section } from '@/components/Section'
import { StatusBadge } from '@/components/StatusBadge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api } from '@/lib/api'
import { countryName } from '@/lib/countries'
import { when } from '@/lib/format'
import { message, say } from '@/lib/messages'
import * as schema from '@/lib/schemas'

type Finding = { kind: 'video' | 'signature' | 'expiry' | 'ip' | 'page' | 'country'; state: 'ok' | 'problem' | 'note'; message: string }
type Result = {
  plays: boolean
  data: Finding[]
  country: string
  signature: { expires_at: string; key_id: string; acl: string; ip: string; watermark: string } | null
}

const KIND: Record<Finding['kind'], string> = { video: 'Video', signature: 'Signature', expiry: 'Expiry', ip: 'Viewer address', page: 'Page', country: 'Country' }
const STATE = { ok: ['success', 'Works'], problem: ['danger', 'Problem'], note: ['warning', 'Note'] } as const
const pageRule = schema.address('invalid_url', { https: true, path: true, query: true })

/** Explains why the address one viewer used does or doesn't play: the signature, its expiry, and the library's website and country rules. */
export function LinkCheck({ asset }: { asset: string }) {
  const [form, setForm] = useState({ url: '', page: '', ip: '' })
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [got, setGot] = useState<Result | null>(null)
  const [failure, setFailure] = useState('')
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => (setForm({ ...form, [k]: e.target.value }), setProblems({}), setGot(null))

  async function check() {
    const p: Record<string, string> = {}
    if (!form.url.trim()) p.url = say('invalid_request')
    if (form.page.trim() && !v.safeParse(pageRule, form.page).success) p.page = say('invalid_url')
    if (form.ip.trim() && !schema.validIP(form.ip.trim())) p.ip = say('invalid_ip')
    setProblems(p)
    if (Object.keys(p).length) return
    setBusy(true)
    setFailure('')
    try {
      setGot(await api<Result>('POST', `/v1/assets/${asset}/link-check`, { url: form.url.trim(), page: form.page.trim(), ip: form.ip.trim() }))
    } catch (err) {
      setGot(null)
      setFailure(message(err))
    } finally {
      setBusy(false)
    }
  }

  const sig = got?.signature
  const facts: Fact[] = sig
    ? [
        ['Expires', when(sig.expires_at)],
        ['Signing key', <span key="k" className="font-mono">{sig.key_id}</span>],
        ['Covers', <span key="a" className="font-mono">{sig.acl}</span>],
        ...(sig.ip ? [['Only from IP', <span key="i" className="font-mono">{sig.ip}</span>] as Fact] : []),
        ...(sig.watermark ? [['Watermark', sig.watermark] as Fact] : []),
      ]
    : []
  if (got?.country) facts.push(['Viewer country', countryName(got.country)])

  return (
    <Section
      title={
        <>
          Check a viewer's link
          <HelpTip label="How does this work?">
            When a viewer can't watch, ask them for the address their player loads (or copy it from your page) and paste it here. We check it with
            the same rules playback uses and say which one refuses it. Their IP address (they can find it by searching "what is my IP") lets us
            check country rules and links signed for one address.
          </HelpTip>
        </>
      }
      description="Why does it play for some viewers and not others?"
      action={
        <Button type="submit" form="link-check" size="sm" variant="outline" disabled={busy}>
          {busy && <Spinner />}
          {got ? 'Check again' : 'Check'}
        </Button>
      }
      bodyClassName="grid gap-4"
    >
      <form id="link-check" className="grid gap-4" noValidate onSubmit={(e) => (e.preventDefault(), void check())}>
        <Field invalid={!!problems.url}>
          <FieldLabel htmlFor="link-url">Viewer's address</FieldLabel>
          <FieldDescription>The watch page or stream address the viewer used, with its ?token=…, or just the signature.</FieldDescription>
          <Input id="link-url" className="font-mono" value={form.url} onChange={set('url')} placeholder="https://player.example.com/…?token=exp=…" aria-invalid={!!problems.url || undefined} />
          {problems.url && <FieldError>{problems.url}</FieldError>}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field invalid={!!problems.page}>
            <FieldLabel htmlFor="link-page">Embedded on (optional)</FieldLabel>
            <Input id="link-page" className="font-mono" value={form.page} onChange={set('page')} placeholder="https://example.com/lessons/1" aria-invalid={!!problems.page || undefined} />
            {problems.page && <FieldError>{problems.page}</FieldError>}
          </Field>
          <Field invalid={!!problems.ip}>
            <FieldLabel htmlFor="link-ip">Viewer's IP address (optional)</FieldLabel>
            <Input id="link-ip" className="font-mono" value={form.ip} onChange={set('ip')} placeholder="203.0.113.7" aria-invalid={!!problems.ip || undefined} />
            {problems.ip && <FieldError>{problems.ip}</FieldError>}
          </Field>
        </div>
      </form>
      {failure && (
        <Alert variant="error">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {got && (
        <>
          <Alert variant={got.plays ? 'success' : 'warning'}>
            <AlertTitle>{got.plays ? 'This link plays' : "This link doesn't play"}</AlertTitle>
            <AlertDescription>{got.plays ? 'Every rule lets it through. If it still fails for the viewer, run Check playback above.' : 'The rule that refuses it is marked below, with what to change.'}</AlertDescription>
          </Alert>
          {got.data.map((f) => (
            <div key={f.kind + f.message} className="grid gap-1 text-sm">
              <span className="flex items-center gap-2">
                <span className="font-medium">{KIND[f.kind]}</span>
                <StatusBadge tone={STATE[f.state][0]}>{STATE[f.state][1]}</StatusBadge>
              </span>
              <span className={f.state === 'problem' ? 'text-destructive' : 'text-muted-foreground'}>{f.message}</span>
            </div>
          ))}
          {facts.length > 0 && <Facts rows={facts} />}
        </>
      )}
    </Section>
  )
}
