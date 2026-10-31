import { Button } from '@/components/ui/button'
import { Footer } from '@/components/Section'
import { Pagination, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious } from '@/components/ui/pagination'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { number } from '@/lib/format'
import type { Pager } from '@/lib/query'

const SIZES = [10, 25, 50, 100].map((n) => ({ value: String(n), label: String(n) }))

type BarProps = { size: number; setSize: (n: number) => void; from: number; to: number; total?: number; hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void; loading?: boolean; sizes?: { value: string; label: string }[] }

/** The foot of a table, as in coss's table particles: rows per page and the range shown on the left, previous / next on the right. Put it last inside the table's Section. */
export function PagerBar({ size, setSize, from, to, total, hasPrev, hasNext, onPrev, onNext, loading, sizes = SIZES }: BarProps) {
  return (
    <Footer className="p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <p className="text-sm text-muted-foreground">Rows per page</p>
          <Select items={sizes} value={String(size)} onValueChange={(v) => v && setSize(Number(v))}>
            <SelectTrigger size="sm" aria-label="Rows per page" className="w-fit min-w-none">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {sizes.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            <strong className="font-medium text-foreground tabular-nums">
              {number(from)}–{number(to)}
            </strong>
            {total !== undefined && (
              <>
                {' '}
                of <strong className="font-medium text-foreground tabular-nums">{number(total)}</strong> results
              </>
            )}
          </p>
        </div>
        <Pagination className="mx-0 w-auto justify-end">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious className="sm:*:[svg]:hidden" render={<Button disabled={!hasPrev || loading} onClick={onPrev} size="sm" variant="outline" />} />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext className="sm:*:[svg]:hidden" render={<Button disabled={!hasNext || loading} onClick={onNext} size="sm" variant="outline" />} />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </Footer>
  )
}

/** The pager of a list read with `usePager`. */
export function TablePager({ pager, sizes }: { pager: Pager<never>; sizes?: { value: string; label: string }[] }) {
  if (!pager.rows?.length && !pager.hasPrev) return null
  return <PagerBar size={pager.size} setSize={pager.setSize} from={pager.from} to={pager.to} total={pager.total} hasPrev={pager.hasPrev} hasNext={pager.hasNext} onPrev={pager.prev} onNext={() => void pager.next()} loading={pager.loading} sizes={sizes} />
}
