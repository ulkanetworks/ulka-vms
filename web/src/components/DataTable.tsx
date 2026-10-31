import type { ReactNode } from 'react'
import { flexRender, rowPaginationFeature, tableFeatures, useTable, type ColumnDef, type RowData } from '@tanstack/react-table'
import { Search } from '@/components/icons'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Section } from '@/components/Section'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TablePager } from '@/components/TablePager'
import { LoadError } from '@/components/LoadError'
import type { Pager } from '@/lib/query'
import { cn } from '@/lib/utils'
import { stickyFirst, stickyLast, useOverflow } from '@/components/stickyTable'

// Paging is the server's (cursor by cursor): TanStack holds the page and count, the pager moves them.
export const features = tableFeatures({ rowPaginationFeature })
/** A column of a DataTable over rows of T. */
export type Column<T extends RowData> = ColumnDef<typeof features, T>

type Props<T extends RowData> = {
  columns: Column<T>[]
  /** From `usePager`: one page of rows, the totals and the way to the next page. */
  pager: Pager<T>
  rowKey: (row: T) => string
  /** Shown instead of the table when there are no rows and nothing is searched or filtered. */
  empty: ReactNode
  /** Whether a search or filter is on, so "nothing matches" is told apart from "nothing yet". */
  narrowed: boolean
  /** Makes rows clickable (and Enter on a focused row): called with the row, unless a link, button or switch inside it was the target. */
  onRowClick?: (row: T) => void
  /** What a clickable row is called for screen readers, e.g. "Open job 12". */
  rowLabel?: (row: T) => string
}

const NONE: never[] = [] // one empty list while loading, so the table isn't rebuilt every render
const INNER = 'a,button,input,select,textarea,label,[role=switch],[role=checkbox],[role=menuitem],[role=combobox]'

/** The one list look: the table in its Frame, rows per page and previous / next in the foot. */
export function DataTable<T extends RowData>({ columns, pager, rowKey, empty, narrowed, onRowClick, rowLabel }: Props<T>) {
  const rows = pager.rows ?? NONE
  const overflow = useOverflow()
  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: rowKey,
    manualPagination: true,
    rowCount: pager.total,
    pageCount: pager.total === undefined ? (pager.hasNext ? pager.page + 2 : pager.page + 1) : undefined,
    initialState: { pagination: { pageIndex: pager.page, pageSize: pager.size } },
  })
  if (pager.error) return <LoadError error={pager.error} retry={pager.refetch} />
  if (rows.length === 0 && !pager.hasPrev) {
    if (!narrowed) return <>{empty}</>
    return (
      <Section>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search />
              </EmptyMedia>
              <EmptyTitle>Nothing matches</EmptyTitle>
              <EmptyDescription>Try another search, or clear the filters.</EmptyDescription>
            </EmptyHeader>
          </Empty>
      </Section>
    )
  }
  // The first column (what the row is) and a last column with no heading (its ⋯ menu) stay put while the rest scrolls.
  const menuLast = !columns.at(-1)?.header || columns.at(-1)?.id === 'actions'
  return (
    <Section bare ref={overflow}>
      <Table variant="card" className={cn(stickyFirst, menuLast && stickyLast)}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => (
                <TableHead key={header.id}>{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody aria-busy={pager.rows === null || undefined}>
          {pager.rows === null && <LoadingRows columns={table.getAllLeafColumns().map((c) => !!c.columnDef.header)} count={Math.min(pager.size, 8)} />}
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              {...(onRowClick && {
                tabIndex: 0,
                'aria-label': rowLabel?.(row.original),
                className: 'cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                onClick: (e) => {
                  const t = e.target as HTMLElement
                  if (e.currentTarget.contains(t) && !t.closest(INNER)) onRowClick(row.original)
                },
                onKeyDown: (e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row.original)
                },
              })}
            >
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pager.rows !== null && <TablePager pager={pager as Pager<never>} />}
    </Section>
  )
}

/** Rows in the table's own shape while its first page loads: the first column a name with a line under it, a column
 * without a heading (the row menu) a small square, the rest one short bar. */
function LoadingRows({ columns, count }: { columns: boolean[]; count: number }) {
  return Array.from({ length: count }, (_, r) => (
    <TableRow key={r} className="hover:bg-transparent">
      {columns.map((titled, c) => (
        <TableCell key={c}>
          {!titled ? (
            <Skeleton className="ms-auto size-6" />
          ) : c === 0 ? (
            <div className="grid gap-1.5">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3 w-24 max-w-full" />
            </div>
          ) : (
            <Skeleton className="h-4 w-20 max-w-full" />
          )}
        </TableCell>
      ))}
    </TableRow>
  ))
}
