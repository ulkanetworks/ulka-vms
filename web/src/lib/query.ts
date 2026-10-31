import { createContext, useContext, useEffect, useState } from 'react'
import { QueryCache, QueryClient, keepPreviousData, queryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { afterChange, api, ApiError } from './api'
import { blocked, message } from './messages'
import { toast } from './toast'

const failing = new Set<string>()

// A request that never got an answer is one of two things: the server is down, or something in the browser or on
// the way stopped this one request. One probe tells them apart, so the toast says which (an adblocker is common).
async function explain(err: unknown): Promise<string> {
  if (!(err instanceof ApiError && err.code === 'network')) return message(err)
  try {
    const res = await fetch('/v1/meta', { method: 'HEAD', cache: 'no-store' })
    return res.ok ? blocked : message(err)
  } catch {
    return message(err)
  }
}

// One cache for the console: going back to a page shows what it had at once and refreshes behind it.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // A refusal from the API (4xx) won't change on retry; a dropped connection might.
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
  queryCache: new QueryCache({
    onError: (err, q) => {
      const path = String(q.queryKey[0])
      // The session ended (expired, signed out elsewhere): to sign-in, as the layouts do on load.
      if (err instanceof ApiError && err.status === 401 && path.startsWith('/v1/')) {
        return location.assign('/login')
      }
      // A refresh failed while the page still shows what it had: keep it, say so once until a read works again.
      if (q.state.data !== undefined && !failing.has(q.queryHash)) {
        failing.add(q.queryHash)
        void explain(err).then((text) => toast(text, 'danger'))
      }
    },
    onSuccess: (_, q) => void failing.delete(q.queryHash),
  }),
})

// Every change (success or failure) reads what is on screen again, so a page never keeps stale rows and a failed
// optimistic edit (below) snaps back to what the server has.
// What a DELETE removed is forgotten first: read again, it could only answer "doesn't exist" while its page closes.
afterChange.run = (gone) => {
  if (gone) queryClient.removeQueries({ predicate: (q) => under(String(q.queryKey[0]), gone) })
  void queryClient.invalidateQueries()
}

/** Whether a read at path is of `of` itself or something inside it (`/x/1` covers `/x/1?a` and `/x/1/b`, not `/x/12`). */
const under = (path: string, of: string) => path === of || path.startsWith(of + '/') || path.startsWith(of + '?')

type Rows = { id?: string } & Record<string, unknown>
type Cached = { data?: Rows[]; pages?: { data: Rows[] }[] } & Rows

/** Optimistic edit: applies `change` to every cached read under `prefix` at once (a list `{data}`, a cursor-paged
 *  list or a single object); the refetch after the change confirms it or puts the old rows back. */
export function patch(prefix: string, change: (rows: Rows[]) => Rows[], one?: (row: Rows) => Rows) {
  queryClient.setQueriesData<Cached>({ predicate: (q) => String(q.queryKey[0]).startsWith(prefix) }, (d) => {
    if (!d) return d
    if (d.pages) return { ...d, pages: d.pages.map((pg) => ({ ...pg, data: change(pg.data) })) }
    if (Array.isArray(d.data)) return { ...d, data: change(d.data) }
    return one ? (one(d) as Cached) : d
  })
}

/** Optimistic: these rows disappear from the lists under `prefix`. */
export const dropRows = (prefix: string, ids: string[]) => patch(prefix, (rows) => rows.filter((r) => !r.id || !ids.includes(r.id)))

/** Optimistic: one row (or the single object read at `prefix`) takes these fields. */
export const editRow = (prefix: string, id: string, fields: Record<string, unknown>) =>
  patch(prefix, (rows) => rows.map((r) => (r.id === id ? { ...r, ...fields } : r)), (r) => (r.id === id || r.id === undefined ? { ...r, ...fields } : r))

/** The options for reading a GET path; a route loader can `ensureQueryData(getOptions(path))` and the page reads it with `useGet`. */
/** How often to read again while the page is open: milliseconds, or decided from what was read last. */
export type Every<T> = number | ((q: { state: { data?: T } }) => number | false | undefined)

export const getOptions = <T>(path: string | null, every?: Every<T>) =>
  queryOptions({
    queryKey: [path],
    queryFn: () => api<T>('GET', path!),
    enabled: path !== null,
    refetchInterval: every,
    placeholderData: keepPreviousData,
  })

/** Reads a GET path through the cache; the path is the key. `every` polls, in milliseconds, while the page is open.
 *  When the path changes (a filter), the last rows stay up until the new ones arrive. */
export function useGet<T>(path: string | null, every?: Every<T>) {
  const opts = getOptions<T>(path, every)
  const q = useQuery(opts)
  useFirst(q.data === undefined && path !== null && q.isPending, () => queryClient.ensureQueryData(opts))
  // `error` is for a read with nothing to show; a failed refresh keeps the rows (the cache toasts it).
  return q.data === undefined ? q : ({ ...q, error: null } as typeof q)
}

/** After a change, refetches every cached read whose path starts with one of these. */
export function refresh(...prefixes: string[]) {
  return queryClient.invalidateQueries({ predicate: (q) => prefixes.some((p) => String(q.queryKey[0]).startsWith(p)) })
}

/** One page at a time of a cursor-paged list (`{data, next_cursor, total?}`), for a table with a pager under it.
 *  Going back replays the cursors already visited; changing the path (filters) or the page size starts over. */
export function usePager<T>(path: string, startSize = 10, enabled = true) {
  const [size, setSize] = useState(startSize)
  const scope = `${path}|${size}`
  const [trail, setTrail] = useState<{ scope: string; cursors: string[] }>({ scope, cursors: [''] })
  const cursors = trail.scope === scope ? trail.cursors : ['']
  const cursor = cursors[cursors.length - 1]
  const url = `${path}${path.includes('?') ? '&' : '?'}limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
  const q = useGet<{ data: T[]; next_cursor: string; total?: number }>(enabled ? url : null)
  const rows = q.data?.data ?? null
  const page = cursors.length - 1
  return {
    rows,
    total: q.data?.total,
    error: q.data ? null : q.error,
    loading: q.isFetching,
    refetch: () => void q.refetch(),
    page,
    size,
    setSize: (n: number) => setSize(n),
    from: rows?.length ? page * size + 1 : 0,
    to: page * size + (rows?.length ?? 0),
    hasNext: !!q.data?.next_cursor,
    hasPrev: page > 0,
    next: () => q.data?.next_cursor && setTrail({ scope, cursors: [...cursors, q.data.next_cursor] }),
    prev: () => setTrail({ scope, cursors: cursors.slice(0, -1) }),
  }
}
export type Pager<T = unknown> = ReturnType<typeof usePager<T>>

/** A cursor-paged list as cards: the rows of every page loaded so far (null until the first arrives), and `more()` for the next.
 *  Tables use `usePager`; grids use this with a Load more button. */
export function usePages<T>(path: string, size = 12) {
  const sized = path.includes('limit=') ? path : `${path}${path.includes('?') ? '&' : '?'}limit=${size}`
  const opts = {
    queryKey: [path, size],
    queryFn: ({ pageParam }: { pageParam: string }) => api<{ data: T[]; next_cursor: string; total?: number }>('GET', pageParam ? `${sized}&cursor=${encodeURIComponent(pageParam)}` : sized),
    initialPageParam: '',
    getNextPageParam: (last: { next_cursor: string }) => last.next_cursor || undefined,
  }
  const q = useInfiniteQuery({ ...opts, placeholderData: keepPreviousData })
  useFirst(q.data === undefined && q.isPending, () => queryClient.ensureInfiniteQueryData(opts))
  return {
    rows: q.data ? q.data.pages.flatMap((pg) => pg.data) : null,
    total: q.data?.pages[0]?.total,
    error: q.data ? null : q.error,
    refetch: () => void q.refetch(),
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    more: () => void q.fetchNextPage(),
  }
}

/** While something is in progress (`busy`), reads everything under `prefix` again every few seconds; stops by itself once it settles. */
export function useWhile(busy: boolean, prefix: string, every = 4000) {
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => void refresh(prefix), every)
    return () => clearInterval(t)
  }, [busy, prefix, every])
}

/** A page's first reads: until the page has shown once, each read it starts waits here, and `Gate` (after the page, in the
 *  shell) shows the diamond until all have arrived. One loading state per page, never a diamond and then skeletons. */
export type FirstReads = { shown: boolean; waiting: Set<Promise<unknown>> }
export const FirstReadsContext = createContext<FirstReads | null>(null)

function useFirst(loading: boolean, fetch: () => Promise<unknown>) {
  const first = useContext(FirstReadsContext)
  if (first && !first.shown && loading) first.waiting.add(fetch().catch(() => {})) // a failure shows the page's own LoadError
}

/** Rendered after the page: every first read has started by now, so they load together; suspends until all are in. */
export function Gate({ first }: { first: FirstReads }) {
  useEffect(() => void (first.shown = true), [first])
  const waiting = [...first.waiting]
  first.waiting.clear()
  if (waiting.length) throw Promise.all(waiting)
  return null
}
