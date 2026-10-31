import { Diamond } from '@/components/Diamond'
import { cn } from '@/lib/utils'

/** A page on its way (its code, or its first reads: lib/query Gate): the green diamond centred in the content panel
 *  (or the screen, outside the shell), sized to its width. The one loading state for a page; never then skeletons. */
export function PageLoading({ className }: { className?: string }) {
  return (
    <div className={cn('@container absolute inset-0 grid place-items-center', className)} aria-busy="true">
      <Diamond className="size-[clamp(1.5rem,6cqi,2.5rem)] text-primary" />
    </div>
  )
}

/** Ulka starting up, before anything is known about the page: the same diamond, on the whole screen. */
export function AppLoading() {
  return <PageLoading className="h-svh bg-background" />
}
