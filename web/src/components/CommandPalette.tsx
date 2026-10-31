import { Fragment, useEffect, useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Search } from '@/components/icons'
import { useGo } from '@/components/AppLink'
import type { NavGroup } from '@/components/Shell'
import { Button } from '@/components/ui/button'
import {
  Command, CommandCollection, CommandDialog, CommandDialogPopup, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem,
  CommandList, CommandPanel, CommandSeparator,
} from '@/components/ui/command'
import { Spinner } from '@/components/ui/spinner'
import { api } from '@/lib/api'

export type Entry = { value: string; label: string; hint?: string; href: string; keywords?: string }
export type Group = { value: string; items: Entry[] }

// What can be searched live, per panel: the list to ask (with ?q=), and how a row becomes an entry.
type Source = { group: string; path: (q: string) => string; entry: (row: Record<string, unknown>) => Entry; local?: boolean }
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const CONSOLE: Source[] = [
  { group: 'Videos', path: (q) => `/v1/assets?limit=5&q=${encodeURIComponent(q)}`, entry: (r) => ({ value: `video-${str(r.id)}`, label: str(r.title) || 'Untitled video', href: `/videos/${str(r.id)}` }) },
  { group: 'Libraries', path: () => '/v1/libraries', local: true, entry: (r) => ({ value: `lib-${str(r.id)}`, label: str(r.name), href: `/videos/library/${str(r.id)}` }) },
]
// Kept once, so defaults don't change identity on every render and undo the memo below.
const NONE: NavGroup[] = []
const NO_SOURCES: Source[] = []

/** Every word typed appears somewhere in the entry's name, hint or keywords. */
const matches = (e: Entry, q: string) => {
  const text = `${e.label} ${e.hint ?? ''} ${e.keywords ?? ''}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.includes(w))
}

/** The pages of the menu, flattened, each under its group's name. */
function pages(groups: NavGroup[]): Entry[] {
  const out: Entry[] = []
  for (const g of groups)
    for (const item of g.items) {
      out.push({ value: `page-${item.href}`, label: item.label, hint: g.label ?? undefined, href: item.href })
      for (const c of item.children ?? []) {
        for (const k of c.children ?? []) out.push({ value: `page-${k.href}`, label: k.label, hint: `${item.label} · ${c.label}`, href: k.href })
        if (!c.children) out.push({ value: `page-${c.href}`, label: c.label, hint: item.label, href: c.href })
      }
    }
  return out
}

/** The command palette: Ctrl/⌘ K anywhere. Pages and live search of videos and libraries;
 * in the docs (`docs`), a fixed list searched in the browser instead. */
export function CommandPalette({ groups = NONE, docs }: { groups?: NavGroup[]; docs?: Group[] }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const go = useGo()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])

  const sources = docs ? NO_SOURCES : CONSOLE
  const live = useQueries({
    queries: sources.map((s) => ({
      queryKey: ['palette', s.path(s.local ? '' : debounced)],
      queryFn: () => api<{ data: Record<string, unknown>[] }>('GET', s.path(debounced)),
      enabled: open && debounced.length >= 2,
      staleTime: 30_000,
    })),
  })
  const searching = live.some((q) => q.isFetching)

  const shown = useMemo(() => {
    const q = query.trim()
    const out: Group[] = []
    // Matches in the name come before matches only in the hint or keywords.
    const rank = (e: Entry) => (e.label.toLowerCase().includes(q.toLowerCase()) ? 0 : 1)
    const keep = (items: Entry[]) => (q ? items.filter((e) => matches(e, q)).sort((a, b) => rank(a) - rank(b)) : items)
    if (docs) return docs.map((g) => ({ value: g.value, items: keep(g.items).slice(0, q ? 25 : 6) })).filter((g) => g.items.length)
    if (debounced.length >= 2)
      sources.forEach((s, i) => {
        const rows = live[i]?.data?.data ?? []
        const items = rows.map(s.entry).filter((e) => !s.local || matches(e, debounced))
        if (items.length) out.push({ value: s.group, items: items.slice(0, 5) })
      })
    out.push({ value: 'Pages', items: keep(pages(groups)) })
    return out.filter((g) => g.items.length)
  }, [query, debounced, live, groups, sources, docs])

  const choose = (e: Entry) => {
    setOpen(false)
    setQuery('')
    go(e.href)
  }

  return (
    <>
      <Button variant="outline" size="sm" className="hidden w-56 justify-start text-muted-foreground sm:flex" onClick={() => setOpen(true)} aria-label="Search">
        <Search />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="rounded border px-1 font-mono text-[0.7rem]">{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd>
      </Button>
      <Button variant="ghost" size="icon-sm" className="sm:hidden" onClick={() => setOpen(true)} aria-label="Search">
        <Search />
      </Button>
      <CommandDialog open={open} onOpenChange={(o) => (setOpen(o), o || setQuery(''))}>
        <CommandDialogPopup>
          <Command items={shown} filter={null} value={query} onValueChange={(v) => setQuery(String(v ?? ''))}>
            <div className="relative flex items-center *:first:flex-1">
              <CommandInput placeholder={docs ? 'Search guides, API operations, events and error codes…' : 'Search pages, videos and libraries…'} />
              {searching && <Spinner className="me-3" />}
            </div>
            <CommandPanel>
              <CommandEmpty>{query.trim() ? 'Nothing matches that.' : ''}</CommandEmpty>
              <CommandList>
                {(group: Group) => (
                  <Fragment key={group.value}>
                    <CommandGroup items={group.items}>
                      <CommandGroupLabel>{group.value}</CommandGroupLabel>
                      <CommandCollection>
                        {(e: Entry) => (
                          <CommandItem key={e.value} value={e} onClick={() => choose(e)}>
                            <span className="flex-1 truncate">{e.label}</span>
                            {e.hint && <span className="truncate text-muted-foreground text-xs">{e.hint}</span>}
                          </CommandItem>
                        )}
                      </CommandCollection>
                    </CommandGroup>
                    <CommandSeparator />
                  </Fragment>
                )}
              </CommandList>
            </CommandPanel>
          </Command>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  )
}
