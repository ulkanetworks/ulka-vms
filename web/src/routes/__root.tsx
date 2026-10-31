import type { QueryClient } from '@tanstack/react-query'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { AppLoading } from '@/components/PageSkeleton'
import { ready } from '@/lib/rules'

// The router context carries the query cache, so any route's loader can prefetch through it.
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // The API's rules, so every form checks against the same limits the API enforces. A loader, not beforeLoad, so the
  // layouts' own reads (/v1/me) start at the same time instead of after it.
  loader: () => ready(),
  pendingComponent: AppLoading,
  component: () => <Outlet />,
})
