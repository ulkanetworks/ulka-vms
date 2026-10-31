import { useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { Outlet, createFileRoute, redirect, useRouter, useRouterState } from '@tanstack/react-router'
import { ChartColumn, Check, Settings, KeyRound, Plus, LayoutGrid, Users, Video, Webhook } from '@/components/icons'
import { api, ApiError, type Me, type TenantSummary } from '@/lib/api'
import { AppLink, useGo } from '@/components/AppLink'
import { Notices } from '@/components/Notices'
import { UploadDock } from '@/components/UploadDock'
import { Shell, type NavGroup } from '@/components/Shell'
import { PlayerHome } from '@/components/player/Home'
import { AppLoading } from '@/components/PageSkeleton'
import { can, onPlayerHost, ready, rules } from '@/lib/rules'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/menu'
import { message } from '@/lib/messages'
import { setZone } from '@/lib/format'
import { LibrarySidebar, libraryIn } from '@/components/library/LibrarySidebar'
import { queryClient, useGet } from '@/lib/query'
import { setUploadLimit } from '@/lib/uploads'

const groups: NavGroup[] = [
  { label: null, items: [{ href: '/', label: 'Overview', icon: LayoutGrid }] },
  {
    label: 'Products',
    items: [
      {
        href: '/videos',
        label: 'Video',
        icon: Video,
        children: [
          { href: '/videos', label: 'Libraries' },
          { href: '/videos/defaults', label: 'Defaults' },
          { href: '/videos/signing-keys', label: 'Video signing keys' },
        ],
      },
    ],
  },
  {
    label: 'Developer',
    items: [
      { href: '/api-keys', label: 'API keys', icon: KeyRound },
      { href: '/webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/members', label: 'Members', icon: Users },
      { href: '/usage', label: 'Usage', icon: ChartColumn },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

export const Route = createFileRoute('/_app')({
  staleTime: 60_000,
  gcTime: 0,
  loader: async () => {
    // The player host has no console: its home (the only console address Caddy lets through there) shows a sample video.
    if (location.pathname === '/') {
      await ready()
      if (onPlayerHost()) return { me: null as unknown as Me } // no console page renders on the player host, so none reads it
    }
    try {
      const me = await api<Me>('GET', '/v1/me')
      setUploadLimit(me.max_upload_bytes)
      return { me }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw redirect({ href: '/login' })
      throw err
    }
  },
  pendingComponent: AppLoading,
  component: AppLayout,
})

function AppLayout() {
  const data = Route.useLoaderData()
  return data.me ? <Console me={data.me} /> : <PlayerHome />
}

function Console({ me }: { me: Me }) {
  // API keys are listed only to those who manage them (the API refuses the rest).
  const shown = groups.map((g) => ({ ...g, items: g.items.filter((i) => i.href !== '/api-keys' || can(me, 'keys:read')) }))
  setZone(me.user?.timezone)
  const router = useRouter()
  const go = useGo()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const libraryId = libraryIn(pathname)
  const email = me.user?.email ?? ''
  const [wanted, setWanted] = useState(false)
  const [problem, setProblem] = useState('')
  // The switcher's list loads when first opened, so every page load doesn't pay for it.
  const tenants = useGet<{ data: TenantSummary[] }>(wanted ? '/v1/tenants' : null)
  const listProblem = tenants.error ? message(tenants.error) : ''

  async function switchTo(id: string) {
    if (id === me.tenant.id) return
    try {
      await api('POST', `/v1/tenants/${id}/switch`)
      queryClient.clear() // everything cached belongs to the workspace being left
      await router.invalidate()
      go('/')
    } catch (err) {
      setProblem(message(err))
    }
  }
  async function signOut() {
    await api('POST', '/v1/logout').catch(() => {})
    queryClient.clear()
    go('/login')
  }

  const workspaces = (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {listProblem ? (
          <p className="px-2 text-xs text-muted-foreground">{listProblem}</p>
        ) : !tenants.data ? (
          <div className="grid gap-1 p-1" aria-busy="true">{[0, 1].map((i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
        ) : (
          tenants.data.data.map((t) => (
            <DropdownMenuItem key={t.id} disabled={!!t.suspended_at} onClick={() => void switchTo(t.id)}>
              <span className="mr-auto truncate">{t.name}</span>
              {t.suspended_at && <span className="text-xs text-muted-foreground">Suspended</span>}
              {t.id === me.tenant.id && <Check />}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuGroup>
      {rules.signup_open && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<AppLink href="/settings?tab=workspace&new" />}>
            <Plus />
            New workspace
          </DropdownMenuItem>
        </>
      )}
    </>
  )

  const notice = (
    <div className="grid gap-4 empty:hidden">
      {problem && (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </div>
  )

  return (
    <Shell contextual={libraryId ? <LibrarySidebar id={libraryId} /> : undefined} groups={shown} home="/" person={me.user?.name || email.split('@')[0] || me.tenant.name} email={email} place={me.tenant.name} onsignout={signOut} alerts={<Notices />} workspaces={workspaces} onMenuOpen={() => setWanted(true)} footerLink={{ href: '/docs', label: 'Docs' }} notice={notice}>
      <Outlet />
      <UploadDock />
    </Shell>
  )
}
