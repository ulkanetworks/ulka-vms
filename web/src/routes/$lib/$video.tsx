import { createFileRoute } from '@tanstack/react-router'
import { Watch } from '@/components/player/Watch'
import { checkIds, watchSearch } from '@/lib/watch'

// A video on the player host: /{library}/{video}.
export const Route = createFileRoute('/$lib/$video')({ validateSearch: watchSearch, beforeLoad: checkIds, component: Page })

function Page() {
  return <Watch search={Route.useSearch()} />
}
