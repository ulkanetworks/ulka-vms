import { useEffect, useRef, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import type { Notice } from '@/lib/api'
import { AlertsMenu } from '@/components/AlertsMenu'
import { AppLink } from '@/components/AppLink'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { ago, number } from '@/lib/format'
import { refresh, useGet } from '@/lib/query'

const plural = (n: number, one: string, many: string) => `${number(n)} ${n === 1 ? one : many}`

// What needs attention, as the API works it out; this only words each kind and links to where it's fixed.
function words(n: Notice): { text: string; href: string } {
  switch (n.kind) {
    case 'videos_failed':
      return { text: `${plural(n.data?.count ?? 0, 'video', 'videos')} couldn't be processed this week.`, href: '/videos' }
    case 'key_expiring':
      return { text: `The API key “${n.name}” stops working ${ago(n.at)}. Create a replacement before then.`, href: '/api-keys' }
    case 'key_expired':
      return { text: `The API key “${n.name}” has expired. Revoke it to tidy the list.`, href: '/api-keys' }
    case 'limit_encode_minutes':
      return { text: `You've used ${number(Math.round(n.data?.used ?? 0))} of ${number(n.data?.limit ?? 0)} encoding minutes this month.`, href: '/usage' }
    case 'support_visit':
      return { text: `Support (${n.name}) used your workspace as ${n.data?.person} ${ago(n.at)}: “${n.data?.reason}”. Everything they changed is on record.`, href: '/members' }
    default:
      return { text: 'Something needs your attention.', href: '/' }
  }
}

/** `session` is shown first and puts a dot on the bell: the support session banner, which never sits in the page. */
export function Notices({ session }: { session?: ReactNode }) {
  const query = useGet<{ data: Notice[] }>('/v1/notices', 60_000)
  const notices = query.data?.data ?? null
  const path = useRouterState({ select: (s) => s.location.pathname })
  // Fresh after each page change too, so a fix shows as gone without a reload.
  const first = useRef(true)
  useEffect(() => {
    if (!first.current) void refresh('/v1/notices')
    first.current = false
  }, [path])

  const urgent = (notices ?? []).filter((n) => n.severity !== 'info').length

  return (
    <AlertsMenu count={urgent} warn={!!session}>
      {session}
      {query.isError && !notices ? (
        <p className="text-sm text-muted-foreground">Couldn't load notifications. They'll try again in a minute.</p>
      ) : notices === null ? (
        <div className="grid gap-2" aria-label="Loading notifications">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : notices.length === 0 ? (
        <p className="text-sm text-muted-foreground">All clear. Nothing needs your attention.</p>
      ) : (
        notices.map((n) => {
          const w = words(n)
          return (
            <AppLink key={n.id} href={w.href}>
              <Alert variant={n.severity === 'danger' ? 'error' : 'default'}>
                <AlertDescription>{w.text}</AlertDescription>
              </Alert>
            </AppLink>
          )
        })
      )}
    </AlertsMenu>
  )
}
