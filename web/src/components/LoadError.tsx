import { RefreshCw } from '@/components/icons'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { message } from '@/lib/messages'

/** A read that failed with nothing to show: the API's words and a Try again. */
export function LoadError({ error, retry }: { error: unknown; retry?: () => unknown }) {
  return (
    <Alert variant="error" className="flex items-center justify-between gap-3">
      <AlertDescription>{message(error)}</AlertDescription>
      {retry && (
        <Button size="sm" variant="outline" onClick={() => void retry()}>
          <RefreshCw />
          Try again
        </Button>
      )}
    </Alert>
  )
}
