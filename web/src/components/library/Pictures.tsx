import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Check, CloudUpload, ExternalLink } from '@/components/icons'
import { CopyText } from '@/components/CopyText'
import { StatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Section } from '@/components/Section'
import { api, type Asset } from '@/lib/api'
import { timecode } from '@/lib/format'
import { message, say } from '@/lib/messages'
import { refresh } from '@/lib/query'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { SaveBar } from '@/components/SaveBar'

const MAX_BYTES = 25 << 20 // the API's limit for a picture (image_too_large)
const TILE = 'relative aspect-video w-full overflow-hidden rounded-lg bg-muted outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait'
const SELECTED = 'ring-2 ring-primary ring-offset-2 ring-offset-background'

type Choice = { kind: 'frame'; time: number } | { kind: 'upload' } | { kind: 'file'; file: File; url: string }
type At = (file: string) => string

/** "1:23", "1:02:03", "83" or "12.5" as seconds; null when it isn't a time. */
function parseTime(text: string): number | null {
  const parts = text.trim().split(':')
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null
  return parts.reduce((t, p) => t * 60 + Number(p), 0)
}

/** The thumbnail: a large view of the selection beside the frames the API suggests and an upload tile. A click only
 *  selects; Save in the header makes it the thumbnail, Discard goes back. A check marks the one in use. */
export function ThumbnailCard({ asset, at }: { asset: Asset; at?: At }) {
  const p = asset.poster
  const saved: Choice | null = p.source === 'upload' ? { kind: 'upload' } : p.time !== null ? { kind: 'frame', time: p.time } : null
  const [picked, setPicked] = useState<Choice | null>(null)
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const shown = picked ?? saved
  const length = asset.duration_seconds ?? 0
  // Any moment: the slider and the box follow the selected frame; a new frame is fetched only on release or Enter.
  const [moment, setMoment] = useState(shown?.kind === 'frame' ? shown.time : 0)
  const [typed, setTyped] = useState<string | null>(null)
  const shownTime = shown?.kind === 'frame' ? shown.time : null
  useEffect(() => { if (shownTime !== null) setMoment(shownTime) }, [shownTime])
  const typedTime = typed === null ? null : parseTime(typed)
  const typedBad = typed !== null && (typedTime === null || typedTime > length)
  const pickMoment = (t: number) => setPicked({ kind: 'frame', time: Math.round(Math.min(Math.max(t, 0), length) * 10) / 10 })
  const same = (a: Choice | null, b: Choice | null) => !!a && !!b && a.kind === b.kind && (a.kind !== 'frame' || (b.kind === 'frame' && Math.abs(a.time - b.time) < 0.05))
  const dirty = !!picked && !same(picked, saved)
  // A frame chosen through the API that isn't among the suggestions still shows.
  const frames = saved?.kind === 'frame' && !p.suggestions.some((t) => Math.abs(t - saved.time) < 0.05) ? [...p.suggestions, saved.time] : p.suggestions
  useEffect(() => () => { if (picked?.kind === 'file') URL.revokeObjectURL(picked.url) }, [picked])

  const pickFile = (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return toast(say('not_an_image'), 'danger')
    if (f.size > MAX_BYTES) return toast(say('image_too_large'), 'danger')
    setPicked({ kind: 'file', file: f, url: URL.createObjectURL(f) })
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    pickFile(e.dataTransfer.files[0])
  }
  async function save() {
    if (!picked) return
    setSaving(true)
    try {
      if (picked.kind === 'file') await api('PUT', `/v1/assets/${asset.id}/poster/image`, picked.file)
      else if (picked.kind === 'frame') await api('PUT', `/v1/assets/${asset.id}/poster`, { time: picked.time === p.suggestions[0] ? null : picked.time })
      await refresh(`/v1/assets/${asset.id}`)
      setPicked(null)
      toast('Thumbnail saved.')
    } catch (err) {
      toast(message(err), 'danger')
    } finally {
      setSaving(false)
    }
  }

  const big = !at || !shown ? null : shown.kind === 'file' ? shown.url : shown.kind === 'upload' ? at(`poster.webp?width=960&v=${encodeURIComponent(asset.updated_at)}`) : at(`thumbnail.webp?time=${shown.time}&width=960`)
  const caption = !shown ? '' : shown.kind === 'frame' ? `Frame at ${timecode(shown.time)}` : 'Your picture'
  const inUse = (c: Choice) => same(c, saved)

  return (
    <Section
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
      title="Thumbnail"
      description="The picture shown before the video plays and in your library. Pick a frame or use your own picture, then save."
      action={
        <>
          <SaveBar dirty={!!dirty} saving={saving} onSave={() => void save()} onDiscard={() => setPicked(null)} />
        </>
      }
    >
        {!at || !p.suggestions.length ? (
          <p className="text-sm text-muted-foreground">You can choose a thumbnail once the video is ready.</p>
        ) : (
          <div className={cn('grid gap-6 rounded-lg md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]', dragging && 'ring-2 ring-primary ring-offset-4 ring-offset-background')}>
            <figure className="grid content-start gap-2">
              <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
                {big && <img src={big} alt={`Thumbnail: ${caption}`} className="size-full object-cover" />}
              </div>
              <figcaption className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium">{caption}</span>
                <span className="text-muted-foreground">{dirty ? 'Not saved yet' : 'In use'}</span>
              </figcaption>
            </figure>
            <div className="grid min-w-0 content-start gap-4">
              {/* As many columns as fit, so tiles never run past the card. */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5">
                <button type="button" disabled={saving} onClick={() => input.current?.click()} className={cn(TILE, 'grid place-items-center border border-dashed bg-transparent text-muted-foreground hover:border-foreground/30 hover:text-foreground', picked?.kind === 'file' && SELECTED)} aria-label="Upload your own picture">
                  {picked?.kind === 'file' ? <img src={picked.url} alt="" className="absolute inset-0 size-full object-cover" /> : (
                    <span className="grid justify-items-center gap-1 text-xs">
                      <CloudUpload className="size-4" />
                      Upload
                    </span>
                  )}
                </button>
                <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/avif" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
                {saved?.kind === 'upload' && (
                  <Tile selected={shown?.kind === 'upload'} inUse label="Your picture (in use)" disabled={saving} onClick={() => setPicked({ kind: 'upload' })} src={at(`poster.webp?width=320&v=${encodeURIComponent(asset.updated_at)}`)} />
                )}
                {frames.map((t) => (
                  <Tile
                    key={t}
                    selected={shown?.kind === 'frame' && Math.abs(shown.time - t) < 0.05}
                    inUse={inUse({ kind: 'frame', time: t })}
                    label={`Frame at ${timecode(t)}`}
                    time={t}
                    disabled={saving}
                    onClick={() => setPicked({ kind: 'frame', time: t })}
                    src={at(`thumbnail.webp?time=${t}&width=320`)}
                  />
                ))}
              </div>
              <Field invalid={typedBad} className="gap-2">
                <FieldLabel htmlFor={`moment-${asset.id}`}>Or pick any moment</FieldLabel>
                <div className="flex w-full min-w-0 items-center gap-3">
                  <Slider
                    className="min-w-0 flex-1"
                    aria-label="Moment in the video"
                    min={0}
                    max={length}
                    step={0.1}
                    value={moment}
                    disabled={saving}
                    onValueChange={(v) => { setMoment(v as number); setTyped(null) }}
                    onValueCommitted={(v) => pickMoment(v as number)}
                  />
                  <Input
                    id={`moment-${asset.id}`}
                    value={typed ?? timecode(moment)}
                    disabled={saving}
                    onChange={(e) => setTyped(e.target.value)}
                    onBlur={() => { if (typedTime !== null && !typedBad) pickMoment(typedTime); setTyped(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && typedTime !== null && !typedBad) { pickMoment(typedTime); setTyped(null) } }}
                    className="w-28 shrink-0 font-mono tabular-nums"
                    aria-invalid={typedBad || undefined}
                  />
                </div>
                {typedBad && <FieldError>{say('invalid_time')}</FieldError>}
              </Field>
              <p className="text-xs text-muted-foreground">Your own picture: JPEG, PNG, WebP, GIF or HEIF, up to 25 MB. Drop it anywhere on this card.</p>
            </div>
          </div>
        )}
    </Section>
  )
}

function Tile({ selected, inUse, label, time, disabled, onClick, src }: { selected: boolean; inUse: boolean; label: string; time?: number; disabled: boolean; onClick: () => void; src: string }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-pressed={selected} aria-label={label + (inUse ? ' (in use)' : '')} className={cn(TILE, selected && SELECTED)}>
      <img src={src} alt="" loading="lazy" className="size-full object-cover" />
      {inUse && (
        <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm">
          <Check className="size-3" strokeWidth={3} />
        </span>
      )}
      {time !== undefined && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1 font-mono text-[11px] leading-4 text-white tabular-nums">{timecode(time)}</span>}
    </button>
  )
}

/** For people using their own player: whether the timeline pictures are ready, and the addresses of the files.
 *  The sheet itself isn't shown: it is raw material the player cuts up. */
export function TimelinePictures({ asset, at, signed }: { asset: Asset; at?: At; signed: boolean }) {
  const [missing, setMissing] = useState(false)
  const address = (file: string) => (signed ? `${asset.embed_url}/${file}?token=SIGNATURE` : `${asset.embed_url}/${file}`)
  return (
    <Section title="Timeline pictures" description="Pictures players show above the timeline while someone drags along it. the player uses them already; for your own player, give it the WebVTT file." bodyClassName="grid gap-4">
        {/* Only a check that the sheet exists: a hidden image that reports whether it loads. */}
        {at && !missing && <img src={at('storyboard.jpg')} alt="" hidden onError={() => setMissing(true)} />}
        <p className="flex items-center gap-2 text-sm">
          <StatusBadge variant={at && !missing ? 'default' : 'secondary'}>{at && !missing ? 'Ready' : 'Being made'}</StatusBadge>
          <span className="text-muted-foreground">{at && !missing ? 'Hover the preview player\'s timeline to see them.' : 'They are made a few minutes after the video is ready.'}</span>
        </p>
        <dl className="grid gap-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4">
          <dt className="text-muted-foreground">WebVTT index</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 flex-1"><CopyText value={address('storyboard.vtt')} what="WebVTT address" /></span>
            {at && !missing && (
              <Button variant="ghost" size="icon-xs" render={<a href={at('storyboard.vtt')} target="_blank" rel="noopener" aria-label="Open the WebVTT file" />}>
                <ExternalLink />
              </Button>
            )}
          </dd>
          <dt className="text-muted-foreground">Thumbnail</dt>
          <dd className="min-w-0"><CopyText value={address('poster.webp')} what="Thumbnail address" /></dd>
          <dt className="text-muted-foreground">A frame at any moment</dt>
          <dd className="min-w-0"><CopyText value={address('thumbnail.jpg') + (signed ? '&' : '?') + 'time=30&width=640'} what="Frame address" /></dd>
        </dl>
    </Section>
  )
}
