import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { ChevronDown, ChevronUp, Ellipsis } from '@/components/icons'
import { AppLink } from '@/components/AppLink'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Section } from '@/components/Section'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { stickyFirst, stickyLast, useOverflow } from '@/components/stickyTable'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Asset } from '@/lib/api'
import { ago, size, timecode, when } from '@/lib/format'
import { statusBadge } from '@/lib/status'
import { badgeVariant } from '@/lib/tone'
import { cn } from '@/lib/utils'
import { StatusBadge } from '@/components/StatusBadge'
import { titleOf, videoItems, type VideoActions } from './VideoCard'
import { VideoThumb } from './VideoThumb'
import { PrivacyBadge } from './Privacy'

type Props = {
  rows: Asset[]
  trash: boolean
  selected: Set<string>
  onSelect: (id: string, on: boolean) => void
  onSelectAll: (on: boolean) => void
  actions: (a: Asset) => VideoActions
  /** The video whose side panel is open, highlighted; a click or Enter on a row opens its panel. */
  active?: string
  onPeek: (a: Asset) => void
  onDragStart: (e: DragEvent, a: Asset) => void
  /** The folders of the current folder, shown first (FolderRow elements). */
  folders?: React.ReactNode
  /** Which way "Added" sorts now; clicking its header flips it. */
  sort: 'newest' | 'oldest'
  onSort: (to: 'newest' | 'oldest') => void
}

/** The videos as a table, like a file manager: select, drag onto a folder, click the title or double-click to open, right-click for actions. */
export function VideoTable({ rows, trash, selected, onSelect, onSelectAll, actions, active, onPeek, onDragStart, folders, sort, onSort }: Props) {
  const all = rows.length > 0 && rows.every((a) => selected.has(a.id))
  // Title click and double-click open the full page; a click or Enter on the row opens the side panel.
  const activate = (a: Asset) => !trash && actions(a).onOpen()
  const clickTitle = (e: MouseEvent, a: Asset) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    activate(a)
  }
  const peek = (e: MouseEvent | KeyboardEvent, a: Asset) => {
    if ((e.target as HTMLElement).closest('a,button,input,[role=checkbox]')) return
    if ('key' in e) {
      if (e.key !== 'Enter' && e.key !== ' ') return
      if (e.target !== e.currentTarget) return
      e.preventDefault()
    }
    onPeek(a)
  }
  const overflow = useOverflow()
  return (
    <Section bare ref={overflow}>
      <Table variant="card" className={cn(stickyFirst, stickyLast)}>
        <TableHeader>
          <TableRow>
            <TableHead>
              <span className="flex items-center gap-3">
                <Checkbox checked={all} indeterminate={!all && selected.size > 0} disabled={rows.length === 0} onCheckedChange={(c) => onSelectAll(c === true)} aria-label="Select all" />
                Name
              </span>
            </TableHead>
            <TableHead className="hidden sm:table-cell">Status</TableHead>
            <TableHead className="hidden md:table-cell">Privacy</TableHead>
            <TableHead className="hidden text-right md:table-cell">Length</TableHead>
            <TableHead className="hidden text-right lg:table-cell">Size</TableHead>
            <TableHead className="hidden sm:table-cell" aria-sort={trash ? undefined : sort === 'oldest' ? 'ascending' : 'descending'}>
              {trash ? (
                'Added'
              ) : (
                <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => onSort(sort === 'newest' ? 'oldest' : 'newest')}>
                  Added
                  {sort === 'oldest' ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                </button>
              )}
            </TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {folders}
          {rows.map((a) => {
            const act = actions(a)
            const badge = statusBadge[a.status]
            const title = titleOf(a)
            const file = a.passthrough && a.passthrough !== title ? a.passthrough : ''
            return (
              <ContextMenu key={a.id}>
                <ContextMenuTrigger render={<TableRow data-state={selected.has(a.id) ? 'selected' : undefined} aria-current={active === a.id || undefined} tabIndex={0} />} draggable onDragStart={(e: DragEvent) => onDragStart(e, a)} onClick={(e: MouseEvent) => peek(e, a)} onKeyDown={(e: KeyboardEvent) => peek(e, a)} onDoubleClick={() => activate(a)} className={cn('cursor-pointer outline-none focus-visible:bg-muted/60', selected.has(a.id) && 'bg-muted', active === a.id && 'bg-accent')}>
                  <TableCell>
                    <div className="flex min-w-64 items-center gap-3">
                      <Checkbox checked={selected.has(a.id)} onCheckedChange={(c) => onSelect(a.id, c === true)} aria-label={`Select ${title}`} />
                      <VideoThumb asset={a} width={160} className="w-20 shrink-0 rounded-md" />
                      <div className="grid min-w-0 gap-0.5">
                        {trash ? (
                          <span className="truncate text-sm font-medium">{title}</span>
                        ) : (
                          <AppLink href={`/videos/${a.id}`} draggable={false} onClick={(e) => clickTitle(e, a)} className="truncate text-sm font-medium hover:underline">
                            {title}
                          </AppLink>
                        )}
                        {file && <span className="truncate text-xs text-muted-foreground">{file}</span>}
                        <StatusBadge variant={badgeVariant(badge.tone)} className="mt-1 w-fit sm:hidden">
                          {badge.text}
                        </StatusBadge>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <StatusBadge variant={badgeVariant(badge.tone)}>{badge.text}</StatusBadge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell"><PrivacyBadge policy={a.playback_policy} /></TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{a.duration_seconds ? timecode(a.duration_seconds) : '—'}</TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums lg:table-cell">{a.size_bytes ? size(a.size_bytes) : '—'}</TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    <time dateTime={a.created_at} title={when(a.created_at)}>
                      {ago(a.created_at)}
                    </time>
                  </TableCell>
                  <TableCell>
                    <Menu>
                      <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${title}`} />}>
                        <Ellipsis />
                      </MenuTrigger>
                      <MenuPopup align="end">{videoItems(a, trash, act, MenuItem, MenuSeparator)}</MenuPopup>
                    </Menu>
                  </TableCell>
                </ContextMenuTrigger>
                <ContextMenuPopup>{videoItems(a, trash, act, ContextMenuItem, ContextMenuSeparator)}</ContextMenuPopup>
              </ContextMenu>
            )
          })}
        </TableBody>
      </Table>
    </Section>
  )
}
