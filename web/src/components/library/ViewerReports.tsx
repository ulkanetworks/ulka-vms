import { useState, type ReactNode } from 'react'
import { CopyText } from '@/components/CopyText'
import { DataTable, type Column } from '@/components/DataTable'
import { FindReport } from '@/components/FindReport'
import { CircleCheck } from '@/components/icons'
import { RowDialog } from '@/components/RowDialog'
import { Section } from '@/components/Section'
import { StatusBadge } from '@/components/StatusBadge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { TITLES, type Step, type StepId } from '@/lib/check'
import { countryName } from '@/lib/countries'
import { dt } from '@/lib/format'
import { usePager } from '@/lib/query'
import { rules } from '@/lib/rules'

export type ViewerReport = { code: string; ip: string; country: string; user_agent: string; plays: boolean; results: Step[]; created_at: string }

const stamp = dt(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const title = (id: string) => TITLES[id as StepId] ?? id
const firstProblem = (r: ViewerReport) => r.results.find((s) => s.state === 'problem')
const cell = (f: (r: ViewerReport) => ReactNode): Column<ViewerReport>['cell'] => ({ row }) => f(row.original)
const COLUMNS: Column<ViewerReport>[] = [
  { id: 'code', header: 'Code', cell: cell((r) => <span className="font-mono">{r.code}</span>) },
  { id: 'when', header: 'When', cell: cell((r) => <span className="whitespace-nowrap text-muted-foreground">{stamp.format(new Date(r.created_at))}</span>) },
  { id: 'result', header: 'Result', cell: cell((r) => (r.plays ? <StatusBadge tone="success">Plays</StatusBadge> : <StatusBadge tone="danger">{title(firstProblem(r)?.id ?? '')}</StatusBadge>)) },
  { id: 'viewer', header: 'Viewer', cell: cell((r) => <span className="whitespace-nowrap text-muted-foreground">{[r.country && countryName(r.country), r.ip].filter(Boolean).join(' · ')}</span>) },
]
const STATE: Record<string, [string, string]> = { ok: ['OK', 'success'], note: ['Note', 'warning'], problem: ['Problem', 'danger'], skipped: ['Skipped', 'neutral'] }

/** What viewers' own browsers found with the playback check, kept 30 days; a viewer gives the code. */
export function ViewerReports({ asset }: { asset: string }) {
  const pager = usePager<ViewerReport>(`/v1/assets/${asset}/playback-reports`)
  const [peek, setPeek] = useState<ViewerReport | null>(null)
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <h2 className="font-medium">Viewer reports</h2>
          <p className="text-muted-foreground text-sm">
            A viewer who can't watch runs the playback check from the player's right-click menu, or at <span className="font-mono">{rules.player_url}/check</span>, and gives you the code. Kept 30 days.
          </p>
        </div>
        <FindReport path={(code) => `/v1/playback-reports/${code}`} links={() => []} />
      </div>
      <DataTable
        columns={COLUMNS}
        pager={pager}
        rowKey={(r) => r.code}
        narrowed={false}
        onRowClick={setPeek}
        rowLabel={(r) => `Report ${r.code}`}
        empty={
          <Section><Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><CircleCheck /></EmptyMedia>
              <EmptyTitle>No reports</EmptyTitle>
              <EmptyDescription>Reports viewers send for this video appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty></Section>
        }
      />
      {peek && <ReportDialog report={peek} onClose={() => setPeek(null)} />}
    </section>
  )
}

/** One report: who sent it, then each step as their browser found it, with the server's own words where it had any. */
export function ReportDialog({ report, onClose, extra = [] }: { report: ViewerReport; onClose: () => void; extra?: [string, ReactNode][] }) {
  const device = report.results.find((s) => (s.id as string) === 'device')?.facts ?? []
  const steps = report.results.filter((s) => (s.id as string) !== 'device')
  return (
    <RowDialog
      title={`Report ${report.code}`}
      subtitle={stamp.format(new Date(report.created_at))}
      onClose={onClose}
      rows={[
        ...extra,
        ['Code', <CopyText value={report.code} what="report code" />],
        ['Result', report.plays ? 'Every step passed' : `Stopped at: ${title(firstProblem(report)?.id ?? '')}`],
        ['Viewer', <CopyText value={report.ip} what="address" />],
        ['Country', report.country ? countryName(report.country) : 'Unknown'],
        ...(device.length ? device : [['Browser', report.user_agent || '—'] as [string, string]]),
      ]}
    >
      <ul className="mt-4 divide-y rounded-lg border">
        {steps.map((s) => {
          const [word, tone] = STATE[s.state] ?? ['—', 'neutral']
          return (
            <li key={s.id} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium">{title(s.id)}</span>
                  {s.value && <span className="truncate font-mono text-muted-foreground text-xs">{s.value}</span>}
                </div>
                {s.detail && <p className="text-muted-foreground text-sm">{s.detail}</p>}
                {s.cause && s.state !== 'ok' && <p className="text-muted-foreground text-xs">{s.cause}</p>}
                {!!s.facts?.length && (
                  <p className="mt-1 font-mono text-muted-foreground text-xs">{s.facts.map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
                )}
              </div>
              <StatusBadge tone={tone}>{word}</StatusBadge>
            </li>
          )
        })}
      </ul>
    </RowDialog>
  )
}
