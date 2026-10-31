import { Fragment, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Logo } from '@/components/Logo'
import { CommandPalette } from '@/components/CommandPalette'
import { useRouterState } from '@tanstack/react-router'
import { ChevronDown, Check, ExternalLink, Monitor, Moon, LogOut, Sun, type IconComponent } from '@/components/icons'
import { AppLink } from '@/components/AppLink'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { crumb } from '@/lib/crumb'
import { FirstReadsContext, Gate, type FirstReads } from '@/lib/query'
import { PageLoading } from '@/components/PageSkeleton'
import { applyTheme, storedTheme, THEMES, type Theme } from '@/lib/theme'

// A child with its own children is a collapsible group (its href is where its first child lives).
type Child = { href: string; label: string; children?: Child[] }
export type NavItem = { href: string; label: string; icon: IconComponent; children?: Child[] }
export type NavGroup = { label: string | null; items: NavItem[] }
type Props = {
  groups: NavGroup[]
  home: string
  tag?: string
  person: string
  email: string
  place: string
  /** Items for the account menu before the theme, e.g. the workspace switcher; `onMenuOpen` fires each time it opens. */
  workspaces?: ReactNode
  onMenuOpen?: () => void
  /** Replaces the menu (the logo stays), e.g. a library's folders while one is open. */
  contextual?: ReactNode
  /** A link at the foot of the sidebar that opens in a new tab. */
  footerLink?: { href: string; label: string }
  /** Shown in the top bar before the workspace, e.g. notifications. */
  alerts?: ReactNode
  /** A small badge beside the workspace name, e.g. while support is using the workspace. */
  /** Shown above the page, e.g. a reminder to verify an email address. */
  notice?: ReactNode
  onsignout: () => void
  children: ReactNode
}

const THEME_ICON: Record<Theme, IconComponent> = { system: Monitor, light: Sun, dark: Moon }
const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }

const NAMES: Record<string, string> = {
  videos: 'Video',
  'api-keys': 'API keys',
  new: 'New key',
  'signing-keys': 'Video signing keys',
  webhooks: 'Webhooks',
  cdn: 'CDN',
  live: 'Live',
  servers: 'Servers',
  distributions: 'Distributions',
  overview: 'Overview',
  delivery: 'Delivery',
  defaults: 'Defaults',
  images: 'Images',
  members: 'Members',
  settings: 'Settings',
  usage: 'Usage',
  admin: 'Overview',
  nodes: 'Fleet',
  add: 'Add a node',
  queues: 'Queues',
  jobs: 'Jobs',
  scheduler: 'Scheduler',
  workspaces: 'Workspaces',
  people: 'People',
  edge: 'Edge servers',
  providers: 'Providers',
  health: 'Health',
  logs: 'Logs',
  metrics: 'Metrics',
  traces: 'Traces',
  services: 'Services',
  certificates: 'Certificates',
  domains: 'Domains',
  audit: 'Audit log',
}

// Built from the URL; a page whose last segment is an id supplies its name through useCrumb.
function Crumbs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const current = crumb.use()
  const segments = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; href?: string }[] = []
  if (!segments.length) crumbs.push({ label: 'Overview' })
  let path = ''
  segments.forEach((segment, i) => {
    path += `/${segment}`
    const last = i === segments.length - 1
    if (segment === 'library') return // /videos/library/<id>: the library's own name stands for both
    if (segments[i - 1] === 'library') {
      crumbs.push({ label: current.label || '…', href: last && !current.section && !current.trail.length ? undefined : path })
      return
    }
    // /admin/live/streams/<server>/<stream>: the server's name (from the page) stands for both.
    if (segment === 'streams' && segments[i - 1] === 'live') return
    if (segments[i - 1] === 'streams' && !last) return void crumbs.push(...current.lead)
    if (last && segments[i - 1] === 'videos') for (const step of current.lead) crumbs.push(step)
    // An id segment shows the page's own name once loaded, never the raw id.
    crumbs.push({ label: (segment === 'images' && segments[0] !== 'admin' ? 'Image optimization' : NAMES[segment]) ?? (last ? current.label || '…' : segment), href: last && !current.section ? undefined : path })
  })
  if (current.section) crumbs.push({ label: current.section })
  for (const step of current.trail) crumbs.push(step)
  return (
    <Breadcrumb aria-label="Breadcrumb">
      <BreadcrumbList>
        {crumbs.map((c, i) => (
          <Fragment key={c.label + i}>
            <BreadcrumbItem className={i < crumbs.length - 1 ? 'hidden sm:inline-flex' : undefined}>
              {c.href ? (
                <BreadcrumbLink render={<AppLink href={c.href} />}>{c.label}</BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{c.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {c.href && <BreadcrumbSeparator className={i < crumbs.length - 1 ? 'hidden sm:block' : undefined} />}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function AccountMenu({ person, email, place, onsignout, workspaces, onMenuOpen }: Pick<Props, 'person' | 'email' | 'place' | 'onsignout' | 'workspaces' | 'onMenuOpen'>) {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  const pick = (next: Theme) => {
    setTheme(next)
    applyTheme(next)
  }
  return (
    <DropdownMenu onOpenChange={(open) => open && onMenuOpen?.()}>
      {/* Just the avatar: the menu names the person and the workspace. */}
      <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Account and workspace menu (${person}, ${place})`} title={`${person} · ${place}`}>
        <Avatar className="size-8">
          <AvatarFallback className="text-sm">{person.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="end">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Avatar>
            <AvatarFallback>{person.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 flex-1 text-sm leading-tight">
            <span className="truncate font-medium">{person}</span>
            {email && <span className="truncate text-xs text-muted-foreground">{email}</span>}
          </div>
        </div>
        <DropdownMenuSeparator />
        {workspaces && (
          <>
            {workspaces}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          {THEMES.map((option) => {
            const Glyph = THEME_ICON[option]
            return (
              <DropdownMenuItem key={option} onClick={() => pick(option)}>
                <Glyph />
                <span className="mr-auto">{THEME_LABEL[option]}</span>
                {theme === option && <Check />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onsignout}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Shell({ groups, home, tag, person, email, place, workspaces, onMenuOpen, footerLink, contextual, alerts, notice, onsignout, children }: Props) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  // The page on screen is the router's last match, which changes in the same render as the page (the address changes earlier).
  const page = useRouterState({ select: (s) => s.matches.at(-1)?.pathname ?? s.location.pathname })
  const first = useMemo<FirstReads>(() => ({ shown: false, waiting: new Set() }), [page]) // eslint-disable-line react-hooks/exhaustive-deps -- a new page waits afresh
  // The page scrolls inside the panel, not the window, so a new page starts at its top.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [path])
  // The child whose address is the longest match for the page, so /videos/<id> belongs to Library at /videos.
  const leaves = (kids: Child[]): Child[] => kids.flatMap((c) => (c.children ? leaves(c.children) : [c]))
  const currentChild = (kids: Child[]) => leaves(kids).filter((c) => path === c.href || path.startsWith(c.href + '/')).sort((a, b) => b.href.length - a.href.length)[0]?.href
  // Home matches only itself; every other item also owns the pages beneath it.
  const isCurrent = (href: string) => (href === home ? path === home : path.startsWith(href))

  return (
    <SidebarProvider className="h-svh">
      <Sidebar collapsible="offcanvas" variant="inset">
        <SidebarHeader>
          <Logo href={home} tag={tag} className="px-2 py-1.5" />
        </SidebarHeader>
        <SidebarContent>
          {contextual ?? groups.map((group, i) => (
            <SidebarGroup key={group.label ?? i}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarMenu>
                {group.items.map((item) => {
                  const Glyph = item.icon
                  const here = item.children && currentChild(item.children)
                  if (!item.children)
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton tooltip={item.label} isActive={isCurrent(item.href)} render={<AppLink href={item.href} />}>
                            <Glyph />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  return (
                    <Collapsible key={item.href} defaultOpen={isCurrent(item.href)} className="group/collapsible" render={<SidebarMenuItem />}>
                        <CollapsibleTrigger render={<SidebarMenuButton tooltip={item.label} />}>
                            <Glyph />
                            <span>{item.label}</span>
                            <ChevronDown className="ml-auto transition-transform group-data-open/collapsible:rotate-180" />
                          </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {item.children.map((c) =>
                              c.children ? (
                                <Collapsible key={c.label} defaultOpen={!!here && leaves(c.children).some((k) => k.href === here)} className="group/sub" render={<SidebarMenuSubItem />}>
                                  <CollapsibleTrigger render={<SidebarMenuSubButton className="w-full" render={<button type="button" />} />}>
                                    <span>{c.label}</span>
                                    <ChevronDown className="ml-auto transition-transform group-data-open/sub:rotate-180" />
                                  </CollapsibleTrigger>
                                  <CollapsibleContent>
                                    <SidebarMenuSub>
                                      {c.children.map((k) => (
                                        <SidebarMenuSubItem key={k.href}>
                                          <SidebarMenuSubButton isActive={here === k.href} render={<AppLink href={k.href} />}>{k.label}</SidebarMenuSubButton>
                                        </SidebarMenuSubItem>
                                      ))}
                                    </SidebarMenuSub>
                                  </CollapsibleContent>
                                </Collapsible>
                              ) : (
                                <SidebarMenuSubItem key={c.href}>
                                  <SidebarMenuSubButton isActive={here === c.href} render={<AppLink href={c.href} />}>{c.label}</SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              ),
                            )}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </Collapsible>
                  )
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>
        {footerLink && (
          <SidebarFooter>
            <a href={footerLink.href} target="_blank" rel="noopener" className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
              {footerLink.label}
              <ExternalLink className="size-3" />
            </a>
          </SidebarFooter>
        )}
      </Sidebar>
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4 md:rounded-t-xl">
          <SidebarTrigger className="-ml-1" />
          <div className="min-w-0 flex-1 overflow-hidden"><Crumbs /></div>
          <div className="flex shrink-0 items-center gap-2">
            <CommandPalette groups={groups} />
            {alerts}
            <AccountMenu person={person} email={email} place={place} onsignout={onsignout} workspaces={workspaces} onMenuOpen={onMenuOpen} />
          </div>
        </header>
        {/* The panel stays the height of the screen; only its content scrolls. */}
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto grid w-full max-w-6xl min-w-0 grid-cols-1 content-start gap-6 p-4 md:p-6 [view-transition-name:page]">
          {notice}
          {/* A page shows once its first reads are in; until then the diamond (lib/query Gate). */}
          <FirstReadsContext value={first}>
            <Suspense key={page} fallback={<PageLoading className="ulka-wait" />}>
              {children}
              <Gate first={first} />
            </Suspense>
          </FirstReadsContext>
        </main>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
