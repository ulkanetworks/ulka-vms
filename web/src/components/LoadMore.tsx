import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

/** For grids of cards, where numbered pages would be odd: a button under the cards that reads the next ones. Nothing when there are no more. */
export function LoadMore({ more, loading, onClick, label = 'Load more' }: { more: boolean; loading: boolean; onClick: () => void; label?: string }) {
  if (!more) return null
  return (
    <div className="flex justify-center">
      <Button variant="outline" size="sm" disabled={loading} onClick={onClick}>
        {loading && <Spinner />}
        {label}
      </Button>
    </div>
  )
}
