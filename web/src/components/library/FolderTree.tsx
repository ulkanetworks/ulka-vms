import { useState } from 'react'
import { ChevronDown, ChevronRight, Folder as FolderIcon, Home, Trash2 } from '@/components/icons'
import { AppLink } from '@/components/AppLink'
import type { Folder } from '@/lib/api'
import { number } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useVideoDrop } from './dnd'

/** The folders in tree order with their depth; `exclude` leaves out a folder and everything below it. */
export function flatTree(folders: Folder[], exclude?: string) {
  const out: { folder: Folder; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parent_id === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.id === exclude) continue
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** The folder ids from Home down to `id`. */
export function pathTo(folders: Folder[], id: string | null) {
  const path: Folder[] = []
  for (let f = folders.find((x) => x.id === id); f; f = folders.find((x) => x.id === f!.parent_id)) path.unshift(f)
  return path
}

type Props = { libraryId: string; folders: Folder[]; total: number; trashed: number; folder: string | null; trash: boolean; onDropVideos?: (ids: string[], folder: string | null) => void; bare?: boolean; noTrash?: boolean }

function Row({ href, active, icon, label, count, depth = 0, onDrop, toggle }: { href: string; active: boolean; icon: React.ReactNode; label: string; count: number; depth?: number; onDrop?: (ids: string[]) => void; toggle?: { open: boolean; has: boolean; onToggle: () => void } }) {
  const { over, props } = useVideoDrop((ids) => onDrop?.(ids))
  return (
    <div className="flex items-center gap-0.5" style={{ paddingLeft: `${depth * 0.75}rem` }}>
      {toggle &&
        (toggle.has ? (
          <button type="button" className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5" aria-label={toggle.open ? `Collapse ${label}` : `Expand ${label}`} aria-expanded={toggle.open} onClick={toggle.onToggle}>
            {toggle.open ? <ChevronDown /> : <ChevronRight />}
          </button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden="true" />
        ))}
      <AppLink
        href={href}
        {...(onDrop ? props : {})}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0',
          active && 'bg-accent font-medium text-foreground',
          over && 'bg-accent text-foreground ring-2 ring-primary',
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{number(count)}</span>
      </AppLink>
    </div>
  )
}

export function FolderTree({ libraryId, folders, total, trashed, folder, trash, onDropVideos, bare, noTrash }: Props) {
  const base = `/videos/library/${libraryId}`
  // Folders the person folded away; the one being looked at is always shown, so its parents open themselves.
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const inside = new Set(pathTo(folders, folder).map((f) => f.id))
  const hidden = new Set<string>()
  for (const { folder: f } of flatTree(folders)) {
    const parent = f.parent_id
    if (parent && (hidden.has(parent) || (folded.has(parent) && !inside.has(parent)))) hidden.add(f.id)
  }
  const flip = (id: string) => setFolded((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s).add(id)))
  return (
    <nav aria-label="Folders" className={cn('grid gap-0.5', !bare && 'rounded-xl border bg-card p-2 shadow-xs/5')}>
      {!bare && <p className="px-2 pt-1 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Folders</p>}
      <Row href={base} active={!trash && folder === null} icon={<Home />} label="Home" count={total} onDrop={onDropVideos && ((ids) => onDropVideos(ids, null))} />
      {flatTree(folders)
        .filter(({ folder: f }) => !hidden.has(f.id))
        .map(({ folder: f, depth }) => {
          const has = folders.some((x) => x.parent_id === f.id)
          return (
            <Row
              key={f.id}
              href={`${base}?folder=${f.id}`}
              active={!trash && folder === f.id}
              icon={<FolderIcon />}
              label={f.name}
              count={f.videos}
              depth={depth}
              toggle={{ has, open: !folded.has(f.id) || inside.has(f.id), onToggle: () => flip(f.id) }}
              onDrop={onDropVideos && ((ids) => onDropVideos(ids, f.id))}
            />
          )
        })}
      {!noTrash && (
        <div className="mt-1.5 border-t pt-1.5">
          <Row href={`${base}?view=trash`} active={trash} icon={<Trash2 />} label="Trash" count={trashed} />
        </div>
      )}
    </nav>
  )
}
