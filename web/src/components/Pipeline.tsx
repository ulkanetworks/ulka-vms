import { LongText } from '@/components/LongText'
import { StatusBadge } from '@/components/StatusBadge'
import type { Technical } from '@/lib/api'
import { seconds } from '@/lib/format'
import { jobKinds, jobTone, jobWords } from '@/lib/jobs'
import { cn } from '@/lib/utils'

type Step = Technical['pipeline'][number]
const BADGE = { success: 'default', danger: 'destructive', warning: 'secondary', neutral: 'outline', accent: 'default' } as const
const DOT: Record<string, string> = { success: 'bg-emerald-500', danger: 'bg-red-500', warning: 'bg-amber-500 animate-pulse', neutral: 'bg-muted-foreground/50', accent: 'bg-blue-500' }
const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null)

/** The steps of processing in order on one time axis: a dot per step, and a bar that shows when it waited (pale) and ran (solid) within the whole run. */
export function Pipeline({ steps }: { steps: Step[] }) {
  const starts = steps.map((s) => ms(s.created_at)!)
  const ends = steps.map((s) => ms(s.finalized_at) ?? ms(s.attempted_at) ?? ms(s.created_at)!)
  const t0 = Math.min(...starts)
  const total = Math.max(Math.max(...ends) - t0, 1)
  const pct = (t: number) => ((t - t0) / total) * 100

  return (
    <ol className="grid gap-0 px-5 py-4">
      {steps.map((j, i) => {
        const created = ms(j.created_at)!
        const started = ms(j.attempted_at)
        const finished = ms(j.finalized_at)
        const waited = started != null ? started - created : null
        const ran = started != null && finished != null ? finished - started : null
        const tone = jobTone[j.state] ?? 'neutral'
        return (
          <li key={j.id} className="relative grid grid-cols-[1.25rem_1fr] gap-x-3 pb-5 last:pb-0" title={`${j.queue} queue${j.worker ? ` · ${j.worker}` : ''}`}>
            {i < steps.length - 1 && <span aria-hidden="true" className="absolute top-5 bottom-0 left-[0.5rem] w-px bg-border" />}
            <span aria-hidden="true" className={cn('mt-1.5 size-2.5 justify-self-center rounded-full ring-4 ring-background', DOT[tone] ?? DOT.neutral)} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold">{jobKinds[j.kind] ?? j.kind}</span>
                {j.kind === 'encode_chunk' && <span className="text-xs text-muted-foreground">{j.lane === 'fast' ? 'fast' : 'full'} lane, chunk {(j.chunk ?? 0) + 1}</span>}
                {j.stage && <span className="text-xs text-muted-foreground">{j.stage === 'ready' ? 'playable' : 'full ladder'}</span>}
                <StatusBadge variant={BADGE[tone]}>{jobWords[j.state] ?? j.state}</StatusBadge>
                <span className="ml-auto font-mono text-sm text-muted-foreground tabular-nums">{ran != null ? seconds(ran / 1000) : j.state === 'running' ? 'running…' : '—'}</span>
              </div>
              <div className="relative mt-2 h-1.5 rounded-full bg-muted" role="img" aria-label={`Waited ${waited != null ? seconds(waited / 1000) : 'for a free machine'}${ran != null ? `, ran ${seconds(ran / 1000)}` : ''}`}>
                {started != null && <span className="absolute inset-y-0 rounded-full bg-primary/25" style={{ left: `${pct(created)}%`, width: `${Math.max(pct(started) - pct(created), 0.4)}%` }} />}
                {started != null && <span className={cn('absolute inset-y-0 rounded-full', tone === 'danger' ? 'bg-destructive' : 'bg-primary')} style={{ left: `${pct(started)}%`, width: `${Math.max(pct(finished ?? Date.now()) - pct(started), 0.8)}%` }} />}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {waited != null ? `Waited ${seconds(waited / 1000)}` : 'Waiting for a free machine'}
                {j.attempt > 1 && ` · attempt ${j.attempt} of ${j.max_attempts}`}
              </p>
              {j.last_error && (
                <div className="mt-1">
                  <LongText text={j.last_error} label="Last error" className="max-w-md text-xs text-destructive" />
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
