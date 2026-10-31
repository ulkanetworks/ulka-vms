import { Figure } from '@/components/Figure'
import { useMemo } from 'react'
import { Pipeline } from '@/components/Pipeline'
import { Cpu, FileVideo, Film, HardDrive, Info, Network, type IconComponent } from '@/components/icons'
import type { Technical as Tech } from '@/lib/api'
import { Section } from '@/components/Section'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ago, bitrate, number, seconds, size, when } from '@/lib/format'
import { StatusBadge } from '@/components/StatusBadge'
import { StatTile, StatTiles } from '@/components/StatTile'

import { factIcon } from '@/components/Facts'
import { cn } from '@/lib/utils'

type Props = { tech: Tech; show: 'source' | 'encoding' | 'chunks' | 'pipeline' | 'storage' }
type Cell = { state: string; title: string }

const ratio = (r?: string) => {
  const [n, d] = (r ?? '').split('/').map(Number)
  return n && d ? `${Math.round((n / d) * 1000) / 1000} fps` : '—'
}
const CELL = { queued: 'bg-border', running: 'animate-pulse bg-warning', retrying: 'bg-warning opacity-55', done: 'bg-primary', failed: 'bg-destructive' } as Record<string, string>

// A card with a title, a one-line description and its content.
function Box({ title, description, icon: Glyph, children }: { title: string; description: string; icon: IconComponent; children: React.ReactNode }) {
  return (
    <Section
      flush
      title={
        <>
          <Glyph />
          {title}
        </>
      }
      description={description}
    >
      {children}
    </Section>
  )
}
function Nothing({ icon: Glyph, title, description }: { icon: IconComponent; title: string; description?: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Glyph />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  )
}
function Help({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger aria-label={label} className="inline-flex align-middle">
        <Info className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-64">{children}</TooltipPopup>
    </Tooltip>
  )
}

function Facts({ children }: { children: React.ReactNode }) {
  return <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-6 gap-y-4 p-6">{children}</dl>
}
function Fact({ label, children, mono }: { label: React.ReactNode; children: React.ReactNode; mono?: boolean }) {
  const Glyph = typeof label === 'string' ? factIcon(label) : Info
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Glyph className="size-3.5 shrink-0" />
        {label}
      </dt>
      <dd className={cn('mt-1 text-sm font-medium wrap-anywhere', mono && 'font-normal tabular-nums')}>{children}</dd>
    </div>
  )
}
const num = 'text-right tabular-nums'
const muted = 'text-muted-foreground'

export function Technical({ tech, show }: Props) {
  const plan = tech.plan
  const src = tech.source
  const fps = useMemo(() => {
    const [n, d] = (plan?.fps ?? '').split('/').map(Number)
    return n && d ? n / d : 0
  }, [plan])

  // Each piece's state comes from the scheduler: queued, running, retrying, done or failed.
  const lanes = useMemo(() => {
    const rows: { lane: string; label: string; cells: Cell[] }[] = []
    for (const lane of ['fast', 'full', 'audio'] as const) {
      const tasks = tech.tasks.filter((t) => t.lane === lane)
      if (!tasks.length) continue
      rows.push({
        lane,
        label: lane === 'fast' ? '720p + 360p' : lane === 'full' ? 'Full ladder' : 'Audio',
        cells: tasks.map((t) => {
          const state = t.state
          const range = lane === 'audio' || !tech.plan ? 'whole file' : `frames ${number(t.chunk * tech.plan.chunk_frames)}–${number((t.chunk + 1) * tech.plan.chunk_frames - 1)}`
          return { state, title: `Chunk ${t.chunk + 1}, ${range}: ${state}${t.node ? ` on ${t.node}` : ''}${t.attempts > 1 ? `, attempt ${t.attempts}` : ''}` }
        }),
      })
    }
    return rows
  }, [tech])
  const total = tech.storage.reduce((n, g) => n + g.bytes, 0)

  if (show === 'source')
    return (
      <Box title="Source file" icon={FileVideo} description={tech.source_deleted_at ? `The original was deleted ${when(tech.source_deleted_at)}, after 30 days. Renditions are kept.` : 'Read from the original upload. It is kept for 30 days.'}>
        {!src ? (
          <Nothing icon={FileVideo} title="Not read yet" description="These appear once the upload has finished and the file has been read." />
        ) : (
          <Facts>
            <Fact label="Container">{src.container || '—'}</Fact>
            <Fact label="File size" mono>{size(src.size_bytes)}</Fact>
            <Fact label={<>Overall bitrate <Help label="Bitrate">How much data each second of the video takes. Higher usually means sharper picture and bigger files.</Help></>} mono>{src.bit_rate ? bitrate(src.bit_rate) : '—'}</Fact>
            <Fact label="Streams" mono>{src.stream_count}</Fact>
            {src.video && (
              <>
                <Fact label={<>Video codec <Help label="Codec">The format the picture is compressed in, like H.264. Ulka VMS converts whatever you upload into formats every device plays.</Help></>}>
                  {src.video.codec}
                  {src.video.profile ? `, ${src.video.profile}` : ''}
                </Fact>
                <Fact label="Picture" mono>{src.video.width}×{src.video.height}, {src.video.pixel_format ?? '—'}</Fact>
                <Fact label="Frame rate" mono>{ratio(src.video.frame_rate)}</Fact>
                <Fact label="Scan">{!src.video.field_order || src.video.field_order === 'progressive' ? 'Progressive' : `Interlaced (${src.video.field_order})`}</Fact>
                <Fact label="Video bitrate" mono>{src.video.bit_rate ? bitrate(src.video.bit_rate) : '—'}</Fact>
                <Fact label="Transfer">{src.video.color_transfer || 'Not tagged'}</Fact>
              </>
            )}
            {src.audio ? (
              <>
                <Fact label="Audio codec">
                  {src.audio.codec}
                  {src.audio.profile ? `, ${src.audio.profile}` : ''}
                </Fact>
                <Fact label="Channels">
                  {src.audio.channels}
                  {src.audio.channel_layout ? ` (${src.audio.channel_layout})` : ''}
                </Fact>
                <Fact label="Sample rate" mono>{src.audio.sample_rate ? `${number(src.audio.sample_rate)} Hz` : '—'}</Fact>
                <Fact label="Audio bitrate" mono>{src.audio.bit_rate ? bitrate(src.audio.bit_rate) : '—'}</Fact>
              </>
            ) : (
              <Fact label="Audio">None</Fact>
            )}
          </Facts>
        )}
      </Box>
    )

  if (show === 'encoding') {
    if (!plan)
      return (
        <Section>
          <Nothing icon={Film} title="Not planned yet" description="The plan is made once the uploaded file has been read." />
        </Section>
      )
    return (
      <Box title="Encoding" icon={Film} description="Fixed when the file was read, so a retry encodes exactly the same thing.">
        <Facts>
          <Fact label="Output frame rate" mono>{fps ? `${Math.round(fps * 1000) / 1000} fps (${plan.fps})` : '—'}</Fact>
          <Fact label={<>Keyframe every <Help label="Keyframe">A complete picture the player can start from. More often means quicker starts and seeking, at slightly bigger files.</Help></>} mono>
            {plan.gop} frames ({fps ? seconds(plan.gop / fps) : '—'})
          </Fact>
          <Fact label="Chunk length" mono>{number(plan.chunk_frames)} frames ({fps ? seconds(plan.chunk_frames / fps) : '—'})</Fact>
          <Fact label="Chunks" mono>{plan.chunks}</Fact>
          <Fact label="Deinterlace">{plan.deinterlace ? 'Yes' : 'No'}</Fact>
          {plan.encoder && (
            <>
              <Fact label="Encoder">{plan.encoder.codec}, preset {plan.encoder.preset}, CRF {plan.encoder.crf}, {plan.encoder.profile} profile</Fact>
              <Fact label="Segments" mono>{plan.encoder.segment_seconds} s, fMP4</Fact>
              <Fact label="Encryption">{plan.encoder.encryption}</Fact>
            </>
          )}
          {tech.encryption_iv && <Fact label="IV" mono>{tech.encryption_iv}</Fact>}
        </Facts>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rendition</TableHead>
              <TableHead>Size</TableHead>
              <TableHead className="text-right">Bitrate cap</TableHead>
              <TableHead>Made</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.rungs.map((r) => (
              <TableRow key={r.name}>
                <TableCell className="tabular-nums">{r.name}</TableCell>
                <TableCell className={cn('tabular-nums', muted)}>{r.width}×{r.height}</TableCell>
                <TableCell className={num}>{bitrate(r.maxrate_k * 1000)}</TableCell>
                <TableCell className={muted}>{r.lane === 'fast' ? 'First, to play quickly' : 'After, for full quality'}</TableCell>
              </TableRow>
            ))}
            {plan.audio && (
              <TableRow>
                <TableCell className="tabular-nums">audio</TableCell>
                <TableCell className={cn('tabular-nums', muted)}>AAC stereo</TableCell>
                <TableCell className={num}>{bitrate(128000)}</TableCell>
                <TableCell className={muted}>First, to play quickly</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Box>
    )
  }

  if (show === 'pipeline')
    return (
      <Box title="Pipeline" icon={Network} description="Every background job of processing this video, in order. Wait is time spent waiting for a free machine; run is time being processed.">
        {tech.pipeline.length === 0 ? <Nothing icon={Network} title="Nothing has run yet" /> : <Pipeline steps={tech.pipeline} />}
      </Box>
    )

  if (show === 'chunks') {
    if (!tech.tasks.length)
      return (
        <Section>
          <Nothing icon={Cpu} title="No pieces yet" description="The video is split into pieces once the uploaded file has been read." />
        </Section>
      )
    const span = (a: string | null, b: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null)
    const took = tech.tasks.map((t) => span(t.started_at, t.done_at))
    const machineTime = took.reduce<number>((n, t) => n + (t ?? 0), 0)
    const retries = tech.tasks.reduce((n, t) => n + Math.max(t.attempts - 1, 0), 0)
    const machines = Object.entries(
      tech.tasks.reduce<Record<string, { done: number; running: number; time: number }>>((m, t, i) => {
        if (!t.node) return m
        const x = (m[t.node] ??= { done: 0, running: 0, time: 0 })
        if (t.state === 'done') (x.done++, (x.time += took[i] ?? 0))
        if (t.state === 'running') x.running++
        return m
      }, {}),
    ).sort((a, b) => b[1].done - a[1].done)
    const range = (t: Tech['tasks'][number]) => (t.lane === 'audio' || !plan ? 'Whole file' : `${number(t.chunk * plan.chunk_frames)}–${number((t.chunk + 1) * plan.chunk_frames - 1)}`)
    const tone = { done: 'success', running: 'warning', retrying: 'warning', queued: 'neutral', failed: 'danger' } as const
    return (
      <div className="grid gap-4">
        <StatTiles>
          <StatTile label="Pieces done" value={`${number(tech.tasks.filter((t) => t.done).length)} of ${number(tech.tasks.length)}`} />
          <StatTile label="Machine time" value={machineTime ? seconds(Math.round(machineTime)) : '—'} foot={machineTime && fps && plan ? `for ${seconds(Math.round((plan.chunks * plan.chunk_frames) / fps))} of video` : undefined} />
          <StatTile label="Machines" value={number(machines.length)} />
          <StatTile label="Retries" value={number(retries)} foot={tech.tasks.some((t) => t.state === 'failed') ? 'Some pieces gave up' : undefined} />
        </StatTiles>
        {lanes.length > 0 && (
          <Box title="Chunks" icon={Cpu} description="The video is split into short pieces (chunks) processed side by side on different machines, so long videos finish sooner. Hover a cell for details.">
            <div className="grid gap-3 px-6 pt-6 pb-2">
              {lanes.map((row) => (
                <div key={row.lane} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 sm:grid-cols-[7rem_minmax(0,1fr)_3.5rem]">
                  <span className="text-sm font-semibold">{row.label}</span>
                  <div className="order-last col-span-full flex flex-wrap gap-1 sm:order-none sm:col-span-1">
                    {row.cells.map((cell, i) => (
                      <span key={i} className={cn('inline-block size-[1.1rem] rounded-[4px]', CELL[cell.state])} title={cell.title}>
                        <span className="sr-only">{cell.title}</span>
                      </span>
                    ))}
                  </div>
                  <span className="text-right text-xs text-muted-foreground tabular-nums">
                    {row.cells.filter((c) => c.state === 'done').length}/{row.cells.length}
                  </span>
                </div>
              ))}
            </div>
            <p className="flex flex-wrap gap-4 px-6 pt-2 pb-6 text-xs text-muted-foreground">
              {([['queued', 'Queued'], ['running', 'Encoding'], ['retrying', 'Retrying'], ['done', 'Done'], ['failed', 'Failed']] as const).map(([k, label]) => (
                <span key={k} className="inline-flex items-center gap-2">
                  <i className={cn('inline-block size-3 rounded-[4px]', CELL[k], k === 'running' && 'animate-none')} />
                  {label}
                </span>
              ))}
            </p>
          </Box>
        )}
        {machines.length > 0 && (
          <Box title="Machines" icon={Cpu} description="Which encoding machines took this video's pieces, and how long they spent on them.">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Machine</TableHead>
                  <TableHead className="text-right">Pieces done</TableHead>
                  <TableHead className="text-right">Working now</TableHead>
                  <TableHead className="text-right">Time spent</TableHead>
                  <TableHead className="text-right">Per piece</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines.map(([node, m]) => (
                  <TableRow key={node}>
                    <TableCell className="font-mono text-xs">{node}</TableCell>
                    <TableCell className={num}>{number(m.done)}</TableCell>
                    <TableCell className={num}>{number(m.running)}</TableCell>
                    <TableCell className={num}>{m.time ? seconds(Math.round(m.time)) : '—'}</TableCell>
                    <TableCell className={num}>{m.time && m.done ? seconds(Math.round((m.time / m.done) * 10) / 10) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
        <Box title="Pieces" icon={Film} description="Every piece, as the scheduler sees it: where it ran, how often it was tried, how long it waited and took.">
          <div className="max-h-[32rem] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Piece</TableHead>
                  <TableHead>Frames</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Machine</TableHead>
                  <TableHead className="text-right">Tries</TableHead>
                  <TableHead className="text-right">Waited</TableHead>
                  <TableHead className="text-right">Took</TableHead>
                  <TableHead>Last problem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tech.tasks.map((t, i) => {
                  const waited = span(t.queued_at, t.started_at)
                  return (
                    <TableRow key={`${t.lane}-${t.chunk}`}>
                      <TableCell className="tabular-nums">{t.lane === 'audio' ? 'Audio' : `${t.lane === 'fast' ? 'Fast' : 'Full'} ${t.chunk + 1}`}</TableCell>
                      <TableCell className={cn('tabular-nums', muted)}>{range(t)}</TableCell>
                      <TableCell><StatusBadge tone={tone[t.state]}>{t.state === 'running' ? `Encoding ${Math.round(t.progress * 100)}%` : { done: 'Done', retrying: 'Retrying', queued: 'Waiting', failed: 'Failed' }[t.state]}</StatusBadge></TableCell>
                      <TableCell className="font-mono text-xs">{t.node || '—'}</TableCell>
                      <TableCell className={num}>{number(t.attempts)}</TableCell>
                      <TableCell className={num}>{waited != null ? seconds(Math.round(waited * 10) / 10) : '—'}</TableCell>
                      <TableCell className={num} title={t.done_at ? when(t.done_at) : undefined}>{took[i] != null ? seconds(Math.round(took[i]! * 10) / 10) : t.started_at && !t.done ? `since ${ago(t.started_at)}` : '—'}</TableCell>
                      <TableCell className={cn('max-w-64 truncate text-xs', t.error ? 'text-destructive' : muted)} title={t.error}>{t.error || '—'}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </Box>
      </div>
    )
  }

  return (
    <Box title="Storage" icon={HardDrive} description="Counted from where the video's files are stored.">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Folder</TableHead>
            <TableHead className="text-right">Files</TableHead>
            <TableHead className="text-right">Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tech.storage.map((g) => (
            <TableRow key={g.name}>
              <TableCell className="tabular-nums">{g.name}</TableCell>
              <TableCell className={num}><Figure n={g.objects} /></TableCell>
              <TableCell className={num}><Figure n={g.bytes} kind="bytes" /></TableCell>
            </TableRow>
          ))}
          <TableRow className="font-bold">
            <TableCell>Total</TableCell>
            <TableCell className={num}><Figure n={tech.storage.reduce((n, g) => n + g.objects, 0)} /></TableCell>
            <TableCell className={num}><Figure n={total} kind="bytes" /></TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Box>
  )
}
