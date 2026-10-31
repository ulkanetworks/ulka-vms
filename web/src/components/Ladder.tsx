import type { Asset } from '@/lib/api'
import { Progress } from '@/components/ui/progress'
import { share } from '@/lib/format'

// One bar per rendition, filling as it encodes: whole pieces done plus how far the ones underway have got.
export function Ladder({ asset }: { asset: Asset }) {
  const p = asset.progress
  const rows = (asset.renditions ?? []).map((r) => ({
    name: r.name,
    size: `${r.width}×${r.height}`,
    note: r.lane === 'fast' ? 'Plays first' : 'Follows',
    done: (p?.[r.lane].done ?? 0) + (p?.[r.lane].partial ?? 0),
    total: p?.[r.lane].total ?? 0,
  }))
  if (p && p.audio.total > 0) rows.push({ name: 'Audio', size: 'Stereo', note: 'Plays first', done: p.audio.done + p.audio.partial, total: p.audio.total })
  const settled = asset.status === 'complete'

  if (rows.length === 0) return <p className="text-muted-foreground">{asset.status === 'errored' ? 'No renditions were made.' : 'The renditions appear here once the file has been read.'}</p>

  return (
    <ol className="m-0 grid list-none gap-3 p-0" aria-label="Renditions">
      {rows.map((row) => {
        const lit = settled ? row.total : row.done
        return (
          <li key={row.name} className="grid grid-cols-[3.5rem_1fr] items-center gap-3 sm:grid-cols-[3.5rem_6.5rem_1fr_6.5rem]">
            <span className="font-mono font-medium">{row.name}</span>
            <span className="justify-self-end font-mono text-sm text-muted-foreground sm:justify-self-auto">{row.size}</span>
            <Progress value={row.total ? (lit / row.total) * 100 : 0} aria-label={`${row.name} encoded`} className="col-span-full sm:col-span-1" />
            <span className="text-right text-sm text-muted-foreground max-sm:hidden">{lit === row.total && row.total > 0 ? row.note : share(lit, row.total)}</span>
          </li>
        )
      })}
    </ol>
  )
}
