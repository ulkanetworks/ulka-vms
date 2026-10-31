import { Timeline, type TimelineTone } from '@/components/Timeline'
import type { Asset } from '@/lib/api'
import { ago, dt, remaining, seconds, size, timecode } from '@/lib/format'
import { videoProblem } from '@/lib/messages'
import { cn } from '@/lib/utils'

type Stage = Asset['timeline'][number]
const STEPS: Record<Stage['stage'], [name: string, means: string]> = {
  received: ['Received', 'Your file arrived and processing began.'],
  checked: ['Checked', 'We read the file and planned its qualities.'],
  playable: ['Ready to play', 'The first qualities play; sharper ones follow.'],
  complete: ['All qualities', 'Every quality is made and the video is final.'],
}
const TONE: Record<Stage['state'], TimelineTone> = { done: 'success', running: 'warning', waiting: 'neutral', failed: 'danger' }
const stamp = dt(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const took = (s: number) => (s < 60 ? seconds(Math.round(s * 10) / 10) : remaining(s))
const gap = (a: string | null | undefined, b: string | null | undefined) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null)
// "…, 3.9 times faster than the video plays" when processing beat the video's own length.
const speed = (length: number | null, took: number) => (length && took > 0 && length / took >= 1.1 ? `, ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(length / took)} times faster than it plays` : '')

/** A video's processing from the API: how long it took in one line, then each step with what it means, when it
 *  happened and how long after the one before. */
export function VideoTimeline({ asset }: { asset: Asset }) {
  const stages = asset.timeline
  const fast = asset.renditions?.filter((r) => r.lane === 'fast').map((r) => r.name) ?? []
  const all = asset.renditions?.map((r) => r.name) ?? []
  // What each step produced, from the video itself, so a step says something even without a recorded time.
  const facts: Record<Stage['stage'], string> = {
    received: asset.size_bytes ? `${size(asset.size_bytes)} file` : '',
    checked: [asset.width && asset.height ? `${asset.width}×${asset.height}` : '', asset.duration_seconds ? timecode(asset.duration_seconds) : ''].filter(Boolean).join(' · '),
    playable: fast.length ? `${fast.join(', ')} first` : '',
    complete: all.length ? `${all.length} ${all.length === 1 ? 'quality' : 'qualities'}` : '',
  }
  const at = Object.fromEntries(stages.map((s) => [s.stage, s.at])) as Record<Stage['stage'], string | null>
  const toPlay = gap(at.received, at.playable)
  const toDone = gap(at.received, at.complete)
  const running = stages.find((s) => s.state === 'running')
  const failed = stages.find((s) => s.state === 'failed')
  const summary = failed
    ? `It stopped at "${STEPS[failed.stage][0]}": ${videoProblem(asset.error_code)}`
    : running
      ? `Working on "${STEPS[running.stage][0]}"${at.received ? `, started ${ago(at.received)}` : ''}.`
      : toDone !== null
        ? toPlay !== null
          ? `Ready to play ${took(toPlay)} after it arrived; every quality ${took(toDone)} after${speed(asset.duration_seconds, toDone)}.`
          : `Every quality was ready ${took(toDone)} after it arrived${speed(asset.duration_seconds, toDone)}.`
        : stages.every((s) => s.state === 'done')
          ? `Ready${asset.duration_seconds ? `: ${timecode(asset.duration_seconds)} of video in ${all.length} ${all.length === 1 ? 'quality' : 'qualities'}` : ''}.`
          : 'Waiting for the upload to finish.'

  return (
    <div className="grid gap-4">
      <p className={cn('text-sm', failed && 'text-destructive')}>{summary}</p>
      <Timeline
        items={stages.map((s, i) => {
          const after = i > 0 ? gap(stages[i - 1].at, s.at) : null
          // A done step without its own time happened by the next step that has one.
          const by = !s.at && s.state === 'done' ? stages.slice(i + 1).find((n) => n.at)?.at : null
          const time = s.at ? (
            <>
              <time dateTime={s.at}>{stamp.format(new Date(s.at))}</time>
              {after !== null && after >= 0 && <> · {after < 0.05 ? 'at the same time' : `${took(after)} later`}</>}
            </>
          ) : by ? `By ${stamp.format(new Date(by))}` : { done: 'Done', running: 'In progress', failed: 'Failed', waiting: 'Waiting' }[s.state]
          return {
            key: s.stage,
            tone: TONE[s.state],
            title: STEPS[s.stage][0],
            time,
            children: (
              <>
                <span className="text-muted-foreground">{STEPS[s.stage][1]}</span>
                {facts[s.stage] && s.state !== 'waiting' && <span className="font-medium">{facts[s.stage]}</span>}
              </>
            ),
          }
        })}
      />
    </div>
  )
}
