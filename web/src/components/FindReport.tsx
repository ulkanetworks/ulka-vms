import { useState, type ReactNode } from 'react'
import { InlineAdd } from '@/components/InlineAdd'
import { ReportDialog, type ViewerReport } from '@/components/library/ViewerReports'
import { Button } from '@/components/ui/button'
import { ApiError, api } from '@/lib/api'

/** Finds a viewer's playback report by the code they gave, then shows it; `path` is where the panel looks it up. */
export function FindReport<T extends ViewerReport>({ path, links }: { path: (code: string) => string; links: (r: T) => [string, ReactNode][] }) {
  const [open, setOpen] = useState(false)
  const [found, setFound] = useState<T | null>(null)
  if (!open) return <Button variant="outline" onClick={() => setOpen(true)}>Find viewer report</Button>
  return (
    <>
      <InlineAdd
        label="Report code"
        placeholder="UL-7K3M9Q"
        button="Find"
        onCancel={() => setOpen(false)}
        onAdd={async (code) => {
          try {
            setFound(await api<T>('GET', path(encodeURIComponent(code.toUpperCase()))))
            return false
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) return 'No report has that code. Reports are kept 30 days.'
            throw e
          }
        }}
      />
      {found && <ReportDialog report={found} onClose={() => setFound(null)} extra={links(found)} />}
    </>
  )
}
