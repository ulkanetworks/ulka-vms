import { useState } from 'react'
import { Plus, Trash2 } from '@/components/icons'
import { TagInput } from '@/components/TagInput'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { SaveBar } from '@/components/SaveBar'
import { Section } from '@/components/Section'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api, type Asset, type Chapter } from '@/lib/api'
import { message, say } from '@/lib/messages'
import { refresh } from '@/lib/query'
import { rules } from '@/lib/rules'
import { videoTag } from '@/lib/tags'
import { number } from '@/lib/format'
import { toast } from '@/lib/toast'

/** Saves a change to the video and reloads it; the API's words on failure. */
function useSave(asset: Asset) {
  const [busy, setBusy] = useState(false)
  const save = async (method: 'PATCH' | 'PUT', path: string, body: unknown, done: string) => {
    setBusy(true)
    try {
      await api(method, `/v1/assets/${asset.id}${path}`, body)
      await refresh(`/v1/assets/${asset.id}`)
      toast(done)
      return true
    } catch (err) {
      toast(message(err), 'danger')
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, save }
}

/** The words and labels viewers and your team find the video by. */
export function AboutVideo({ asset }: { asset: Asset }) {
  const { busy, save } = useSave(asset)
  const [description, setDescription] = useState(asset.description)
  const [tags, setTags] = useState(asset.tags)
  const tooLong = description.trim().length > rules.limits.video_text
  const changed = description !== asset.description || tags.join('\n') !== asset.tags.join('\n')
  return (
    <Section bodyClassName="grid gap-4" title="About this video" description="A description and tags help you and your team find it later." action={<SaveBar dirty={changed} saving={busy} onSave={() => { if (!tooLong) void save('PATCH', '', { description, tags }, 'Saved.') }} onDiscard={() => (setDescription(asset.description), setTags(asset.tags))} />}>
      <Field invalid={tooLong}>
        <FieldLabel htmlFor="video-description">Description</FieldLabel>
        <Textarea id="video-description" rows={3} className="[&_textarea]:max-h-48" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What the video is about" aria-invalid={tooLong || undefined} />
        {tooLong ? <FieldError>{say('invalid_video_description')}</FieldError> : <FieldDescription>Up to {number(rules.limits.video_text)} characters.</FieldDescription>}
      </Field>
      <TagInput label="Tags" value={tags} onChange={setTags} check={videoTag} max={rules.limits.tags} placeholder="launch" hint="Short labels, like launch or 2026. Press Enter after each one. The video list can show only one tag's videos." />
    </Section>
  )
}

/** "1:30", "01:02:03" or "90" as seconds; NaN when it isn't a time. */
function seconds(text: string) {
  const parts = text.trim().split(':')
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return NaN
  return parts.reduce((total, p) => total * 60 + Number(p), 0)
}
const clock = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

type Row = { title: string; start: string; end: string }

/** Parts of the video, shown on the player's timeline. Checked here the way the API checks them. */
function chaptersOf(rows: Row[], duration: number | null): Chapter[] | null {
  const out = rows.map((r) => ({ title: r.title.trim(), start_time: seconds(r.start), end_time: seconds(r.end) })).sort((a, b) => a.start_time - b.start_time)
  const end = duration === null ? Infinity : Math.ceil(duration)
  const bad = out.length > rules.limits.chapters || out.some((c, i) => !c.title || c.title.length > 100 || !(c.start_time >= 0) || !(c.end_time > c.start_time) || c.end_time > end || (i > 0 && c.start_time < out[i - 1].end_time))
  return bad ? null : out
}

export function VideoChapters({ asset }: { asset: Asset }) {
  const { busy, save } = useSave(asset)
  const initial = () => asset.chapters.map((c) => ({ title: c.title, start: clock(c.start_time), end: clock(c.end_time) }))
  const [rows, setRows] = useState<Row[]>(initial)
  const [problem, setProblem] = useState('')
  const set = (i: number, part: Partial<Row>) => (setProblem(''), setRows(rows.map((r, j) => (j === i ? { ...r, ...part } : r))))
  const changed = JSON.stringify(rows) !== JSON.stringify(initial())
  const add = () => {
    const last = rows.at(-1)
    const start = last ? seconds(last.end) || 0 : 0
    const end = Math.min(start + 60, asset.duration_seconds ? Math.floor(asset.duration_seconds) : start + 60)
    setRows([...rows, { title: '', start: clock(start), end: clock(end > start ? end : start + 1) }])
  }
  const submit = () => {
    const chapters = chaptersOf(rows, asset.duration_seconds)
    if (!chapters) return setProblem(say('invalid_chapters'))
    void save('PUT', '/chapters', { chapters }, 'Chapters saved.').then((ok) => ok && setRows(chapters.map((c) => ({ title: c.title, start: clock(c.start_time), end: clock(c.end_time) }))))
  }
  return (
    <Section
      bodyClassName="grid gap-4"
      title="Chapters"
      description="Name the parts of the video, like Intro or Questions. Viewers see them on the player's timeline and can jump between them."
      action={
        <>
          <SaveBar dirty={changed} saving={busy} onSave={submit} onDiscard={() => (setProblem(''), setRows(initial()))} />
          <Button size="sm" variant="secondary" disabled={rows.length >= rules.limits.chapters} onClick={add}>
            <Plus />
            Add
          </Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No chapters yet.</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_6rem_6rem_auto] items-center gap-2">
          <span className="text-xs text-muted-foreground">Title</span>
          <span className="text-xs text-muted-foreground">Starts at</span>
          <span className="text-xs text-muted-foreground">Ends at</span>
          <span />
          {rows.map((r, i) => (
            <div key={i} className="contents">
              <Input aria-label={`Chapter ${i + 1} title`} value={r.title} maxLength={100} onChange={(e) => set(i, { title: e.target.value })} placeholder="Intro" />
              <Input aria-label={`Chapter ${i + 1} start`} className="font-mono" value={r.start} onChange={(e) => set(i, { start: e.target.value })} placeholder="0:00" />
              <Input aria-label={`Chapter ${i + 1} end`} className="font-mono" value={r.end} onChange={(e) => set(i, { end: e.target.value })} placeholder="1:30" />
              <Button variant="ghost" size="icon-sm" aria-label={`Remove chapter ${i + 1}`} onClick={() => (setProblem(''), setRows(rows.filter((_, j) => j !== i)))}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
      {problem ? <p role="alert" className="text-sm text-destructive-foreground">{problem}</p> : rows.length > 0 && <p className="text-xs text-muted-foreground">Times as minutes:seconds, like 1:30, or hours:minutes:seconds.</p>}
    </Section>
  )
}

const metaKey = /^[A-Za-z0-9_-]+$/

/** Your app's own key/value pairs on the video, like its id for it; for developers. */
export function VideoMetadata({ asset }: { asset: Asset }) {
  const { busy, save } = useSave(asset)
  const [rows, setRows] = useState(asset.metadata)
  const [problem, setProblem] = useState('')
  const changed = JSON.stringify(rows) !== JSON.stringify(asset.metadata)
  const set = (i: number, part: Partial<{ key: string; value: string }>) => (setProblem(''), setRows(rows.map((r, j) => (j === i ? { ...r, ...part } : r))))
  const submit = () => {
    const clean = rows.map((r) => ({ key: r.key.trim(), value: r.value.trim() }))
    const keys = clean.map((r) => r.key)
    if (clean.some((r) => !metaKey.test(r.key) || r.key.length > rules.limits.meta_key || r.value.length > rules.limits.meta_value) || new Set(keys).size !== keys.length) return setProblem(say('invalid_metadata'))
    void save('PATCH', '', { metadata: clean }, 'Saved.')
  }
  return (
    <Section
      bodyClassName="grid gap-4"
      title="Metadata"
      description="Your own key and value pairs, for your developers: for example your app's id for this video, to find it again through the API."
      action={
        <>
          <SaveBar dirty={changed} saving={busy} onSave={submit} onDiscard={() => (setProblem(''), setRows(asset.metadata))} />
          <Button size="sm" variant="secondary" disabled={rows.length >= rules.limits.metadata} onClick={() => setRows([...rows, { key: '', value: '' }])}>
            <Plus />
            Add
          </Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-2">
          <span className="text-xs text-muted-foreground">Key</span>
          <span className="text-xs text-muted-foreground">Value</span>
          <span />
          {rows.map((r, i) => (
            <div key={i} className="contents">
              <Input aria-label={`Key ${i + 1}`} className="font-mono" value={r.key} maxLength={rules.limits.meta_key} onChange={(e) => set(i, { key: e.target.value })} placeholder="order_id" />
              <Input aria-label={`Value ${i + 1}`} value={r.value} maxLength={rules.limits.meta_value} onChange={(e) => set(i, { value: e.target.value })} placeholder="42" />
              <Button variant="ghost" size="icon-sm" aria-label={`Remove pair ${i + 1}`} onClick={() => (setProblem(''), setRows(rows.filter((_, j) => j !== i)))}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
      {problem && <p role="alert" className="text-sm text-destructive-foreground">{problem}</p>}
    </Section>
  )
}
