import { useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { ChevronDown, Search, Settings, Trash2, Video } from '@/components/icons'
import { AppLink, useGo } from '@/components/AppLink'
import { FolderTree, pathTo } from '@/components/library/FolderTree'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxTrigger, ComboboxValue } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { SelectButton } from '@/components/ui/select'
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from '@/components/ui/sidebar'
import type { Folder, Library } from '@/lib/api'
import { api } from '@/lib/api'
import { number } from '@/lib/format'
import { LIBRARY_TABS } from '@/lib/library-tabs'
import { message } from '@/lib/messages'
import { dropRows, useGet } from '@/lib/query'
import { toast } from '@/lib/toast'

/** The id of the library open in the address, if one is. */
export const libraryIn = (pathname: string) => /^\/videos\/library\/([^/]+)/.exec(pathname)?.[1] ?? null

/** What the sidebar shows while a library is open: back to the libraries, a library switcher with search, Videos and Settings with its sections, the folders as a file explorer, and Trash at the bottom. */
export function LibrarySidebar({ id }: { id: string }) {
  const go = useGo()
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>
  const onSettings = useRouterState({ select: (s) => s.location.pathname.endsWith('/settings') })
  const lib = useGet<Library>(`/v1/libraries/${id}`)
  const libs = useGet<{ data: Library[] }>('/v1/libraries?limit=100')
  const folders = useGet<{ data: Folder[] }>(`/v1/libraries/${id}/folders`)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [finding, setFinding] = useState(false)
  const [q, setQ] = useState('')
  const folder = typeof search.folder === 'string' && search.folder ? search.folder : null
  const trash = !onSettings && search.view === 'trash'
  const tab = typeof search.tab === 'string' && LIBRARY_TABS.some((t) => t.id === search.tab) ? search.tab : 'general'
  const base = `/videos/library/${id}`
  const options = (libs.data?.data ?? []).map((l) => ({ value: l.id, label: l.name }))

  // A search keeps the folders that match and the ones they sit in.
  const all = folders.data?.data ?? []
  const shown = q.trim()
    ? (() => {
        const keep = new Set<string>()
        for (const f of all) if (f.name.toLowerCase().includes(q.trim().toLowerCase())) pathTo(all, f.id).forEach((x) => keep.add(x.id))
        return all.filter((f) => keep.has(f.id))
      })()
    : all

  // Dropping videos on a folder moves them at once; if the move fails they come back.
  async function move(ids: string[], to: string | null) {
    dropRows('/v1/assets', ids)
    try {
      await api('POST', '/v1/assets/move', { ids, library_id: id, folder_id: to ?? 'root' })
      toast('Moved.')
    } catch (err) {
      toast(message(err), 'danger')
    }
  }

  return (
    <>
      <SidebarGroup className="pb-0">
        <Combobox autoHighlight items={options} value={options.find((o) => o.value === id) ?? null} onValueChange={(o) => o && o.value !== id && go(`/videos/library/${o.value}`)}>
          <ComboboxTrigger render={<SelectButton aria-label="Switch library" className="w-full" />}>
            <ComboboxValue placeholder="Select a library" />
          </ComboboxTrigger>
          <ComboboxPopup aria-label="Switch library" align="start">
            <div className="border-b p-2">
              <ComboboxInput className="rounded-md" placeholder="Find a library" showTrigger={false} startAddon={<Search />} />
            </div>
            <ComboboxEmpty>No library found.</ComboboxEmpty>
            <ComboboxList>
              {(o: (typeof options)[number]) => (
                <ComboboxItem key={o.value} value={o}>
                  {o.label}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={!onSettings && !trash} render={<AppLink href={base} />}>
              <Video />
              <span>Videos</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <Collapsible open={settingsOpen || onSettings} onOpenChange={setSettingsOpen} className="group/collapsible" render={<SidebarMenuItem />}>
            <CollapsibleTrigger render={<SidebarMenuButton isActive={onSettings} />}>
              <Settings />
              <span>Settings</span>
              <ChevronDown className="ml-auto transition-transform group-data-open/collapsible:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {LIBRARY_TABS.map((t) => (
                  <SidebarMenuSubItem key={t.id}>
                    <SidebarMenuSubButton isActive={onSettings && tab === t.id} render={<AppLink href={`${base}/settings${t.id === 'general' ? '' : `?tab=${t.id}`}`} />}>
                      {t.label}
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </Collapsible>
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup className="min-h-0 flex-1 border-t">
        <SidebarGroupLabel className="justify-between pr-0">
          Folders
          <Button type="button" variant="ghost" size="icon-xs" aria-label={finding ? 'Stop searching folders' : 'Search folders'} aria-pressed={finding} onClick={() => (setFinding(!finding), setQ(''))}>
            <Search />
          </Button>
        </SidebarGroupLabel>
        {finding && <Input autoFocus size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a folder" aria-label="Find a folder" className="mb-1" />}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {lib.data && folders.data && (
            <FolderTree bare noTrash libraryId={id} folders={shown} total={lib.data.videos} trashed={lib.data.trashed} folder={onSettings ? null : folder} trash={trash} onDropVideos={(ids, to) => void move(ids, to)} />
          )}
          {folders.data && all.length > 0 && shown.length === 0 && <p className="px-2 py-2 text-sm text-muted-foreground">No folders found</p>}
        </div>
      </SidebarGroup>

      <SidebarGroup className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={trash} render={<AppLink href={`${base}?view=trash`} />}>
              <Trash2 />
              <span>Trash</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{number(lib.data?.trashed ?? 0)}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </>
  )
}
