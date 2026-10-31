import { useState } from 'react'
import { Code } from '@/components/Code'
import { CopyButton } from '@/components/CopyButton'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Pick } from '@/components/Pick'
import { Button } from '@/components/ui/button'
import { DialogClose } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { FormDialog, Wizard } from '@/components/Wizard'
import { api, type Asset, type SignedURL } from '@/lib/api'
import { when } from '@/lib/format'
import { message, say } from '@/lib/messages'
import { validIP } from '@/lib/schemas'
import { embedOf } from './Privacy'

const STEPS: [string, string][] = [
  ['How long', 'How long the link works, and what it opens.'],
  ['Who', 'Optionally, one viewer only, and their name on the picture.'],
]
// The API takes 60 seconds to a day.
const LENGTHS = [
  { value: '3600', label: '1 hour' },
  { value: '21600', label: '6 hours' },
  { value: '43200', label: '12 hours' },
  { value: '86400', label: '1 day' },
]
// The API's rule for a watermark, checked here first for quick feedback: one line, 64 characters.
const validMark = (s: string) => [...s].length <= 64 && !/[\u0000-\u001f\u007f]/.test(s)

/** Signs a private video's address for someone (a reviewer, a client) without code: POST /v1/signed-urls, as a
 *  customer's server would. The link and embed code come back ready to copy. */
export function SignedLinkDialog({ asset, open, onOpenChange }: { asset: Asset; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [step, setStep] = useState(0)
  const [length, setLength] = useState('86400')
  const [scope, setScope] = useState<'video' | 'library'>('video')
  const [ip, setIP] = useState('')
  const [mark, setMark] = useState('')
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<SignedURL | null>(null)
  const reset = (o: boolean) => {
    onOpenChange(o)
    if (!o) {
      setStep(0)
      setMade(null)
      setProblems({})
    }
  }

  async function next() {
    if (step === 0) return setStep(1)
    const p: Record<string, string> = {}
    if (ip.trim() && !validIP(ip.trim())) p.ip = say('invalid_ip')
    if (!validMark(mark.trim())) p.mark = say('invalid_watermark')
    setProblems(p)
    if (Object.keys(p).length) return
    setBusy(true)
    try {
      setMade(await api<SignedURL>('POST', '/v1/signed-urls', { video_id: asset.id, scope, expires_in: Number(length), ip: ip.trim() || undefined, watermark: mark.trim() || undefined }))
    } catch (err) {
      setProblems({ form: message(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormDialog open={open} onOpenChange={reset} busy={busy} title="Make a signed link" description="A link to this private video for someone you choose. It stops working when it ends, and can't be changed without breaking it.">
      {made ? (
        <div className="grid min-w-0 gap-4 border-t px-6 py-5 [&>*]:min-w-0">
          <Field>
            <FieldLabel htmlFor="sl-link">Link</FieldLabel>
            <InputGroup>
              <InputGroupInput id="sl-link" readOnly value={made.embed_url} className="font-mono" onFocus={(e) => e.target.select()} />
              <InputGroupAddon align="inline-end">
                <CopyButton value={made.embed_url} what="Link" />
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>
              Works until {when(made.expires_at)}
              {scope === 'library' ? ', for every video in this library' : ''}. If the library lets only some websites show its videos, it plays only on those.
            </FieldDescription>
          </Field>
          <Code label="Embed code" lang="html" code={embedOf({ ...asset, playback_policy: 'public', embed_url: made.embed_url })} wrap />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMade(null)}>Make another</Button>
            <DialogClose render={<Button />}>Done</DialogClose>
          </div>
        </div>
      ) : (
        <Wizard steps={STEPS} step={step} onNext={() => void next()} onBack={() => setStep(0)} busy={busy} finish="Make link">
          {step === 0 ? (
            <>
              <Field>
                <FieldLabel htmlFor="sl-length">Works for</FieldLabel>
                <Pick id="sl-length" value={length} onChange={setLength} options={LENGTHS} />
              </Field>
              <Field>
                <FieldLabel>Opens</FieldLabel>
                <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'video' | 'library')}>
                  <Field className="flex-row items-start gap-3">
                    <RadioGroupItem value="video" id="sl-video" />
                    <FieldLabel htmlFor="sl-video">This video</FieldLabel>
                  </Field>
                  <Field className="flex-row items-start gap-3">
                    <RadioGroupItem value="library" id="sl-library" />
                    <div className="grid gap-1">
                      <FieldLabel htmlFor="sl-library">Every video in its library</FieldLabel>
                      <FieldDescription>One link for a whole course or collection.</FieldDescription>
                    </div>
                  </Field>
                </RadioGroup>
              </Field>
            </>
          ) : (
            <>
              <Field invalid={!!problems.ip}>
                <FieldLabel htmlFor="sl-ip">Only this internet address (optional)</FieldLabel>
                <Input id="sl-ip" value={ip} onChange={(e) => setIP(e.target.value)} placeholder="203.0.113.7" className="font-mono" aria-invalid={!!problems.ip || undefined} />
                {problems.ip ? <FieldError>{problems.ip}</FieldError> : <FieldDescription>The link then works only for a viewer at that address. Leave empty for anyone who has it.</FieldDescription>}
              </Field>
              <Field invalid={!!problems.mark}>
                <FieldLabel htmlFor="sl-mark">Watermark (optional)</FieldLabel>
                <Input id="sl-mark" value={mark} onChange={(e) => setMark(e.target.value)} placeholder="ada@example.com" aria-invalid={!!problems.mark || undefined} />
                {problems.mark ? <FieldError>{problems.mark}</FieldError> : <FieldDescription>Shown over the video in the player, like the viewer's email, so a recording shows whose copy it was.</FieldDescription>}
              </Field>
              {problems.form && <p className="text-sm text-destructive">{problems.form}</p>}
            </>
          )}
        </Wizard>
      )}
    </FormDialog>
  )
}
