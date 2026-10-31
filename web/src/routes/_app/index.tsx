import { Figure } from '@/components/Figure'
import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { TrendingDown, TrendingUp, CloudUpload } from '@/components/icons'
import { AppLink } from '@/components/AppLink'
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts'
import { Notice } from '@/components/Notice'
import { Meta } from '@/components/Meta'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Section, Sections } from '@/components/Section'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import type { Asset } from '@/lib/api'
import { statusBadge } from '@/lib/status'
import { ago, size, when, dt } from '@/lib/format'
import { message } from '@/lib/messages'
import { useGet } from '@/lib/query'
import { useMe } from '@/lib/session'
import { badgeVariant } from '@/lib/tone'
import { StatusBadge } from '@/components/StatusBadge'
import { StatTile, StatTiles } from '@/components/StatTile'
import { METER_HELP } from '@/lib/usage'

export const Route = createFileRoute('/_app/')({ component: Page })

type Row = { meter: string; quantity: number }
type Usage = { totals: Row[]; daily: (Row & { day: string })[] }
type Stats = { total: number; playable: number; processing: number; failed: number; minutes: number }

const month = (offset: number) => {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + offset)
  return d.toISOString().slice(0, 7)
}
const today = dt('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const pct = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' })
const total = (u: Usage | null, meter: string) => u?.totals.find((t) => t.meter === meter)?.quantity ?? 0
// Change against the previous period; nothing to compare with shows no figure rather than an infinite one.
const change = (cur: number, prev: number) => (prev > 0 ? (cur - prev) / prev : null)
const short = dt('en', { day: 'numeric', month: 'short' })
const empty = 'text-sm text-muted-foreground'

const chartConfig = { value: { label: 'Delivered', color: 'var(--primary)' } } satisfies ChartConfig

/** Every day of this month so far, with what was delivered on it (0 for a quiet day). */
function deliveredDays(u: Usage | null) {
  const byDay = new Map((u?.daily ?? []).filter((r) => r.meter === 'video_delivery_bytes').map((r) => [r.day.slice(0, 10), r.quantity]))
  const out: { day: string; value: number }[] = []
  const d = new Date(`${month(0)}-01T00:00:00Z`)
  for (const end = new Date(); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10)
    out.push({ day: key, value: byDay.get(key) ?? 0 })
  }
  return out
}

function Page() {
  const me = useMe()
  const nowQ = useGet<Usage>(`/v1/usage?month=${month(0)}`)
  const lastQ = useGet<Usage>(`/v1/usage?month=${month(-1)}`)
  const statsQ = useGet<Stats>('/v1/video/stats')
  const videosQ = useGet<{ data: Asset[] }>('/v1/assets?limit=5')
  const now = nowQ.data ?? null
  const last = lastQ.data ?? null
  const stats = statsQ.data ?? null
  const videos = videosQ.data?.data ?? []
  const failed = nowQ.error ?? lastQ.error ?? statsQ.error ?? videosQ.error
  const problem = failed ? message(failed) : ''

  // A greeting by the time of day where the person is; checked each minute so it changes over.
  const [clock, setClock] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  const hour = clock.getHours()
  const greeting = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const firstName = (me.user?.name || me.user?.email.split('@')[0] || '').split(' ')[0]

  const fresh = !!stats && stats.total === 0
  const errored = videos.filter((v) => v.status === 'errored')
  const encoded = total(now, 'video_minutes_encoded')
  const delivered = total(now, 'video_delivery_bytes')
  const days = deliveredDays(now)

  const cards =
    stats && now
      ? [
          { label: 'Videos', value: <Figure n={stats.total} />, ch: null, foot: `${stats.playable} playable · ${stats.processing} processing`, note: 'Every video in your libraries, trash left out.' },
          { label: 'Minutes stored', value: <Figure n={Math.round(stats.minutes * 10) / 10} />, ch: null, foot: 'Of playable video', note: METER_HELP.video_minutes_stored },
          { label: 'Minutes encoded, this month', value: <Figure n={Math.round(encoded * 10) / 10} />, ch: change(encoded, total(last, 'video_minutes_encoded')), foot: 'Against last month', note: METER_HELP.video_minutes_encoded },
          { label: 'Delivered, this month', value: <Figure n={delivered} kind="bytes" />, ch: change(delivered, total(last, 'video_delivery_bytes')), foot: 'Against last month', note: METER_HELP.video_delivery_bytes },
        ]
      : []

  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta title="Overview" description="Your workspace at a glance: what needs attention, how things are going, and what to do next." />

      <header className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold">
            {greeting}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          {fresh && <p className="text-muted-foreground">Upload a first video to begin.</p>}
        </div>
        <p className="shrink-0 text-muted-foreground">{today.format(clock)}</p>
      </header>

      {problem && (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      <Notice
        id="overview-videos"
        title={errored.length === 1 ? 'A video could not be processed' : 'Videos could not be processed'}
        tone="danger"
        items={errored.map((v) => ({ key: v.id, text: `${v.title || v.passthrough || 'Untitled video'} failed.`, href: `/videos/${v.id}`, action: 'See why' }))}
      />

      {fresh ? (
        <Section title="Video" bodyClassName="text-sm text-muted-foreground" action={
            <Button variant="outline" size="sm" render={<AppLink href="/videos" />}>
              <CloudUpload />
              Upload a video
            </Button>
          }>
          Upload videos into libraries. Each one is prepared to play smoothly on any phone or screen, and stays encrypted on your storage.
        </Section>
      ) : (
        <>
          <StatTiles>
            {cards.map((c) => (
              <StatTile
                key={c.label}
                label={c.label}
                value={c.value}
                foot={c.foot}
                help={c.note}
                badge={
                  c.ch !== null && (
                    <Badge variant="outline" className="shrink-0">
                      {c.ch < 0 ? <TrendingDown /> : <TrendingUp />}
                      {pct.format(c.ch)}
                    </Badge>
                  )
                }
              />
            ))}
          </StatTiles>

          <Sections>
            <Section title="Video delivered, per day" description="This month, from this server to your viewers. Delivery through your own CDN is counted there." bodyClassName="min-h-48">
              {!now ? (
                <Skeleton className="h-48 w-full" />
              ) : delivered === 0 ? (
                <p className={empty}>Nothing delivered yet this month. It shows here once people watch your videos.</p>
              ) : (
                <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full">
                  <AreaChart data={days}>
                    <defs>
                      <linearGradient id="fillValue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.1} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tickFormatter={(d) => short.format(new Date(`${d}T00:00:00`))} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" labelFormatter={(d) => short.format(new Date(`${d}T00:00:00`))} formatter={(v) => size(Number(v))} />} />
                    <Area dataKey="value" type="natural" fill="url(#fillValue)" stroke="var(--color-value)" />
                  </AreaChart>
                </ChartContainer>
              )}
            </Section>

            <Section title="Recent videos" bodyClassName="min-h-48" action={<Button variant="link" size="sm" render={<AppLink href="/videos" />}>All videos</Button>}>
              {videosQ.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <ul className="grid grid-cols-1 gap-2">
                  {videos.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-3 text-sm">
                      <AppLink href={`/videos/${v.id}`} className="min-w-0 flex-1 truncate hover:underline">
                        {v.title || v.passthrough || 'Untitled video'}
                      </AppLink>
                      <StatusBadge variant={badgeVariant(statusBadge[v.status].tone)}>{statusBadge[v.status].text}</StatusBadge>
                      <span className="w-20 text-right text-xs text-muted-foreground" title={when(v.created_at)}>
                        {ago(v.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </Sections>
        </>
      )}
    </div>
  )
}
