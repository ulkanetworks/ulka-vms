import { useMemo } from 'react'
import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router'
import { Download } from '@/components/icons'
import { groups, guides } from '@/lib/guides/guides'
import { sectionId, type Spec } from '@/lib/docs/spec'
import { useGet } from '@/lib/query'
import { AppLink } from '@/components/AppLink'
import { CommandPalette } from '@/components/CommandPalette'
import { docsEntries } from '@/lib/docs/palette'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'

export const Route = createFileRoute('/docs')({ component: Layout })

function Layout() {
  const path = useRouterState({ select: (r) => r.location.pathname })
  const s = useRouterState({ select: (r) => String((r.location.search as { s?: unknown }).s ?? '') })
  const spec = useGet<Spec>('/v1/openapi.json').data // the reference page shows the error; the sidebar just lists fewer links
  const entries = useMemo(() => docsEntries(spec), [spec])
  const api = [
    ...(spec?.tags ?? []).map((t) => ({ id: sectionId(t.name), name: t.name })),
    ...(spec ? [{ id: 'events', name: 'Webhook events' }, { id: 'errors', name: 'Errors' }] : []),
  ]

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={path === '/docs'} render={<AppLink href="/docs" />}>Overview</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((g) => (
            <SidebarGroup key={g}>
              <SidebarGroupLabel>{g}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {guides.filter((x) => x.group === g).map((x) => (
                    <SidebarMenuItem key={x.slug}>
                      <SidebarMenuButton isActive={path === `/docs/guides/${x.slug}`} render={<AppLink href={`/docs/guides/${x.slug}`} />}>{x.title}</SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
          <SidebarGroup>
            <SidebarGroupLabel>API reference</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive={path === '/docs/api' && !s} render={<AppLink href="/docs/api" />}>Introduction</SidebarMenuButton>
                </SidebarMenuItem>
                {api.map((a) => (
                  <SidebarMenuItem key={a.id}>
                    <SidebarMenuButton isActive={path === '/docs/api' && s === a.id} render={<Link to="/docs/api" search={{ s: a.id }} />}>{a.name}</SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger className="-ml-1" />
          <AppLink href="/docs" className="font-semibold">Ulka VMS docs</AppLink>
          <nav className="ml-2 flex gap-1" aria-label="Docs">
            <Button size="sm" variant={path.startsWith('/docs/guides') ? 'secondary' : 'ghost'} render={<AppLink href="/docs/guides/getting-started" />}>Guides</Button>
            <Button size="sm" variant={path.startsWith('/docs/api') ? 'secondary' : 'ghost'} render={<AppLink href="/docs/api" />}>API reference</Button>
            <Button size="sm" variant="ghost" render={<AppLink href="/changelog" />}>Changelog</Button>
          </nav>
          <div className="ml-auto"><CommandPalette docs={entries} /></div>
          <Button variant="ghost" size="sm" render={<a href="/v1/openapi.json" download="ulka-openapi.json" />}><Download /><span className="max-md:hidden">OpenAPI file</span></Button>
          <Button variant="ghost" size="sm" className="max-sm:hidden" render={<AppLink href="/" />}>Console</Button>
        </header>
        <main className="min-w-0 p-4 pb-16 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
