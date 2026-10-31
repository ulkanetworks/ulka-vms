import { useState, type ReactNode } from 'react'
import { Ellipsis, Folder as FolderIcon } from '@/components/icons'
import { AppLink } from '@/components/AppLink'
import { InlineEdit } from '@/components/InlineEdit'
import { Button } from '@/components/ui/button'
import { TableCell, TableRow } from '@/components/ui/table'
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import type { Folder } from '@/lib/api'
import { ago, number } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useVideoDrop } from './dnd'
import { rules } from '@/lib/rules'

type Props = { folder: Folder; href: string; onSaveName: (name: string) => Promise<string | void>; onMove: () => void; onDelete: () => void; onDropVideos: (ids: string[]) => void }

const videosOf = (n: number) => `${number(n)} ${n === 1 ? 'video' : 'videos'}`

const folderItems = (onRename: () => void, { onMove, onDelete }: Props) => (Item: typeof MenuItem | typeof ContextMenuItem, Sep: typeof MenuSeparator | typeof ContextMenuSeparator) => (
  <>
    <Item onClick={onRename}>Rename</Item>
    <Item onClick={onMove}>Move to…</Item>
    <Sep />
    <Item variant="destructive" onClick={onDelete}>
      Delete
    </Item>
  </>
)

// While renaming, clicks and keys stay in the field instead of opening the folder or reaching the row.
function Renaming({ folder, onSaveName, done, className }: { folder: Folder; onSaveName: Props['onSaveName']; done: () => void; className?: string }): ReactNode {
  return (
    <span className="min-w-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <InlineEdit editing onEditingChange={(on) => !on && done()} value={folder.name} label="Folder name" max={rules.limits.name} onSave={onSaveName} className={className} />
    </span>
  )
}

/** A folder as a row of the video table: open it, drop videos onto it, or use its menu (also on right-click). */
export function FolderRow(props: Props) {
  const { folder, href } = props
  const { over, props: drop } = useVideoDrop(props.onDropVideos)
  const [renaming, setRenaming] = useState(false)
  const actions = folderItems(() => setRenaming(true), props)
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<TableRow />} {...drop} className={cn(over && 'bg-muted ring-2 ring-primary ring-inset')}>
        <TableCell>
          <div className="flex items-center gap-3">
            <span className="size-4 shrink-0" aria-hidden />
            <span className="grid aspect-video w-20 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <FolderIcon className="size-5" />
            </span>
            <div className="grid min-w-0">
              {renaming ? (
                <Renaming folder={folder} onSaveName={props.onSaveName} done={() => setRenaming(false)} className="text-sm font-medium" />
              ) : (
                <AppLink href={href} draggable={false} className="truncate text-sm font-medium hover:underline">
                  {folder.name}
                </AppLink>
              )}
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{videosOf(folder.videos)}</span>
            </div>
          </div>
        </TableCell>
        <TableCell className="hidden sm:table-cell" />
        <TableCell className="hidden md:table-cell" />
        <TableCell className="hidden md:table-cell" />
        <TableCell className="hidden lg:table-cell" />
        <TableCell className="hidden text-muted-foreground sm:table-cell">{ago(folder.created_at)}</TableCell>
        <TableCell>
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${folder.name}`} />}>
              <Ellipsis />
            </MenuTrigger>
            <MenuPopup align="end">{actions(MenuItem, MenuSeparator)}</MenuPopup>
          </Menu>
        </TableCell>
      </ContextMenuTrigger>
      <ContextMenuPopup>{actions(ContextMenuItem, ContextMenuSeparator)}</ContextMenuPopup>
    </ContextMenu>
  )
}

/** A folder as a tile, drawn as a folder (back with its tab, front on top): open it, drop videos onto it, or use its menu (also on right-click). */
export function FolderTile(props: Props) {
  const { folder, href } = props
  const { over, props: drop } = useVideoDrop(props.onDropVideos)
  const [renaming, setRenaming] = useState(false)
  const actions = folderItems(() => setRenaming(true), props)
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<li className="group/folder min-w-0" />} {...drop}>
        <AppLink href={href} aria-label={`Open ${folder.name}`} className={cn('grid aspect-video place-items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring', over && 'bg-muted ring-2 ring-primary')}>
          <svg viewBox="0 0 160 120" aria-hidden className="h-[88%] text-primary drop-shadow-sm transition-transform group-hover/folder:-translate-y-0.5">
            <defs>
              <linearGradient id="folder-front" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity="0.8" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0.9" />
              </linearGradient>
            </defs>
            <path d="M14 4h40a10 10 0 0 1 7.6 3.5L70 18h76a14 14 0 0 1 14 14v74a14 14 0 0 1-14 14H14A14 14 0 0 1 0 106V18A14 14 0 0 1 14 4Z" fill="currentColor" />
            <rect y="28" width="160" height="92" rx="14" fill="var(--background)" />
            <rect y="28" width="160" height="92" rx="14" fill="url(#folder-front)" />
          </svg>
        </AppLink>
        <div className="flex items-start gap-1 pt-2">
          <div className="grid min-w-0 flex-1">
            {renaming ? (
              <Renaming folder={folder} onSaveName={props.onSaveName} done={() => setRenaming(false)} className="text-sm font-medium" />
            ) : (
              <AppLink href={href} className="truncate text-sm font-medium">{folder.name}</AppLink>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">{videosOf(folder.videos)}</span>
          </div>
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${folder.name}`} />}>
              <Ellipsis />
            </MenuTrigger>
            <MenuPopup align="end">{actions(MenuItem, MenuSeparator)}</MenuPopup>
          </Menu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuPopup>{actions(ContextMenuItem, ContextMenuSeparator)}</ContextMenuPopup>
    </ContextMenu>
  )
}
