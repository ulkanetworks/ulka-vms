import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Mark } from '@/components/Logo'
import { Meta } from '@/components/Meta'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export const Route = createFileRoute('/check/')({ component: Page })

const VIDEO = /\/([0-9a-f-]{36})\/([0-9a-f-]{36})(?:\/[^?#]*)?(\?[^#]*)?/

// Support's door into the viewer check: paste the address of a video that won't play.
function Page() {
  const [link, setLink] = useState('')
  const [problem, setProblem] = useState('')
  function go(e: React.FormEvent) {
    e.preventDefault()
    const m = link.trim().match(VIDEO)
    if (!m) {
      setProblem("That isn't a video address. Copy it from the browser's address bar while the video is open.")
      return
    }
    const token = new URLSearchParams(m[3] ?? '').get('token')
    location.assign(`/check/${m[1]}/${m[2]}${token ? `?token=${encodeURIComponent(token)}` : ''}`)
  }
  return (
    <main className="mx-auto mt-[12vh] grid max-w-lg gap-6 px-4">
      <Meta title="Playback check" description="Check why a video won't play in this browser." />
      <div className="flex items-center gap-3">
        <Mark className="size-9" />
        <div>
          <h1 className="font-semibold text-xl">Playback check</h1>
          <p className="text-muted-foreground">Trouble watching a video? Paste its address to check each step.</p>
        </div>
      </div>
      <form onSubmit={go} className="grid gap-4">
        <Field>
          <FieldLabel>Video address</FieldLabel>
          <Input value={link} onChange={(e) => { setLink(e.target.value); setProblem('') }} placeholder="https://player.ulka.co/…" className="font-mono" aria-invalid={!!problem} />
          {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>The address of the page the video plays on, or of the video itself.</FieldDescription>}
        </Field>
        <Button type="submit">Check</Button>
      </form>
    </main>
  )
}
