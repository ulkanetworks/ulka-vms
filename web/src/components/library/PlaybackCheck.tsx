import { useState } from 'react'
import { HelpTip } from '@/components/HelpTip'
import { Section } from '@/components/Section'
import { StatusBadge } from '@/components/StatusBadge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api } from '@/lib/api'
import { ago, number } from '@/lib/format'
import { message } from '@/lib/messages'
import * as schema from '@/lib/schemas'
import * as v from 'valibot'

type Step = { kind: 'settings' | 'playlist' | 'quality' | 'backup' | 'subtitles'; name: string; url: string; ok: boolean; ms: number; message: string }
type Result = { data: Step[]; checked_at: string }

const pageRule = schema.address('invalid_url', { https: true, path: true, query: true })
const label = (s: Step) => (s.kind === 'backup' ? `${s.name} from our origin (backup)` : s.kind === 'subtitles' ? `${s.name} subtitles` : s.name)

/** Plays the video over the network as a viewer's player would, and says which part fails; `detail` (Ulka admin)
 *  adds each step's address and time. */
export function PlaybackCheck({ path, detail }: { path: string; detail?: boolean }) {
  const [page, setPage] = useState('')
  const [busy, setBusy] = useState(false)
  const [got, setGot] = useState<Result | null>(null)
  const [problem, setProblem] = useState('')
  const [pageProblem, setPageProblem] = useState('')
  async function check() {
    const parsed = v.safeParse(pageRule, page)
    const bad = page.trim() && !parsed.success ? parsed.issues[0].message : ''
    setPageProblem(bad)
    if (bad) return
    setBusy(true)
    setProblem('')
    try {
      const q = page.trim() ? `?${new URLSearchParams({ page: page.trim() })}` : ''
      setGot(await api<Result>('GET', `${path}${q}`))
    } catch (err) {
      setGot(null)
      setProblem(message(err))
    } finally {
      setBusy(false)
    }
  }
  const failed = got?.data.filter((s) => !s.ok).length ?? 0
  return (
    <Section
      title={
        <>
          Check playback
          <HelpTip label="How does this work?">
            We play the video from this server the way a player on your website does: its settings, the playlist, then every quality (its
            key, its start and its first piece, unlocked to make sure it's real video) and every subtitle, each as a browser on another website would
            ask. Country rules aren't checked, since the requests come from our server, not your viewers.
          </HelpTip>
        </>
      }
      description="Does the video play for viewers, and if not, which part fails?"
      action={
        <Button type="submit" form="playback-check" size="sm" variant="outline" disabled={busy}>
          {busy && <Spinner />}
          {got ? 'Check again' : 'Check'}
        </Button>
      }
      bodyClassName="grid gap-4"
    >
      <form id="playback-check" noValidate onSubmit={(e) => (e.preventDefault(), void check())}>
        {detail && !got && !problem && <p className="text-sm text-muted-foreground">Plays it from this server as a viewer's player would, step by step, with each address and how long it took. Press Check to run it.</p>}
        {!detail && <Field invalid={!!pageProblem}>
          <FieldLabel htmlFor="check-page">Embedded on (optional)</FieldLabel>
          <Input id="check-page" className="font-mono" value={page} onChange={(e) => (setPage(e.target.value), setPageProblem(''))} placeholder="https://example.com/lessons/1" aria-invalid={!!pageProblem || undefined} />
          <FieldDescription>The page your viewers watch it on, to check the library's list of websites that may show it.</FieldDescription>
          {pageProblem && <FieldError>{pageProblem}</FieldError>}
        </Field>}
      </form>
      {problem && (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {got && (
        <>
          <Alert variant={failed ? 'warning' : 'success'}>
            <AlertTitle>{failed ? `${number(failed)} ${failed === 1 ? 'part fails' : 'parts fail'}` : 'It plays'}</AlertTitle>
            <AlertDescription>{failed ? 'Viewers may see an error or a quality that never loads. Each problem is below.' : 'Every part a player needs loads, and browsers on other websites may use it.'}</AlertDescription>
          </Alert>
          {got.data.map((s) => (
            <div key={s.kind + s.url} className="grid gap-1 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{label(s)}</span>
                {s.ok ? <StatusBadge>Works</StatusBadge> : <StatusBadge variant="destructive">Problem</StatusBadge>}
                {detail && <span className="text-muted-foreground text-xs">{number(s.ms)} ms</span>}
              </span>
              <span className={s.ok ? 'text-muted-foreground' : 'text-destructive'}>{s.message}</span>
              {detail && <span className="font-mono text-muted-foreground text-xs wrap-anywhere">{s.url}</span>}
            </div>
          ))}
          <p className="text-muted-foreground text-xs">Checked {ago(got.checked_at)}.</p>
        </>
      )}
    </Section>
  )
}
