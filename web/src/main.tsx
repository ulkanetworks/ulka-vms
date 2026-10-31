import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter, defaultStringifySearch } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/anek-bangla/standard.css'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/geist'
import './index.css'
import { NotFound, Unavailable } from '@/components/ErrorPage'
import { PageLoading } from '@/components/PageSkeleton'
import { AnchoredToastProvider, ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { queryClient } from '@/lib/query'
import { report } from '@/lib/report'
import { followSystem } from '@/lib/theme'
import { routeTree } from './routeTree.gen'
import '@/lib/address'

// A release replaced the code files this tab started with: load the new ones once, rather than show an error page.
window.addEventListener('vite:preloadError', () => {
  try {
    if (Date.now() - Number(sessionStorage.getItem('ulka-reloaded') ?? 0) < 10_000) return // just reloaded: let the error show
    sessionStorage.setItem('ulka-reloaded', String(Date.now()))
  } catch {
    // no storage: reload anyway
  }
  location.reload()
})

// Errors no page caught are reported too; only our own files, since browser extensions throw on every page.
window.addEventListener('unhandledrejection', (e) => report(e.reason))
window.addEventListener('error', (e) => e.filename.startsWith(location.origin) && report(e.error ?? e.message))

// Empty values are the page's defaults, so they stay out of the address (no ?folder=&view=).
const router = createRouter({
  routeTree,
  stringifySearch: (search) => defaultStringifySearch(Object.fromEntries(Object.entries(search).filter(([, v]) => v !== '' && v !== undefined && v !== null))),
  context: { queryClient },
  defaultPreload: 'intent',
  defaultViewTransition: true, // every navigation through document.startViewTransition(); index.css says what moves
  defaultPreloadStaleTime: 0, // the query cache decides what is fresh
  defaultPendingMs: 200,
  defaultPendingComponent: PageLoading,
  defaultNotFoundComponent: NotFound,
  defaultErrorComponent: Unavailable,
  Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

followSystem()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider position="bottom-right">
      <AnchoredToastProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  </StrictMode>,
)
