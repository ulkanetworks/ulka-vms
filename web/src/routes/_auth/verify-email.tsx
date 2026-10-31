import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { api } from '@/lib/api'
import { message } from '@/lib/messages'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AppLink } from '@/components/AppLink'
import { AuthHeading } from '@/components/AuthShell'
import { Meta } from '@/components/Meta'

export const Route = createFileRoute('/_auth/verify-email')({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === 'string' ? s.token : '',
    kind: s.kind === 'change_email' ? ('change_email' as const) : ('verify_email' as const),
  }),
  component: Page,
})

function Page() {
  const { token, kind } = Route.useSearch()
  const [status, setStatus] = useState<'working' | 'done' | 'failed'>('working')
  const [failure, setFailure] = useState('')

  // Confirming is a POST the page makes once, so mail scanners that prefetch the link don't use it up.
  useEffect(() => {
    let live = true
    api('POST', '/v1/verify-email', { token, kind })
      .then(() => live && setStatus('done'))
      .catch((err) => {
        if (!live) return
        setFailure(message(err))
        setStatus('failed')
      })
    return () => {
      live = false
    }
  }, [token, kind])

  return (
    <>
      <Meta title="Confirm your email" description="Confirm the email address on your account." />
      <AuthHeading title={kind === 'change_email' ? 'Confirm your new email' : 'Confirm your email'} />

      {status === 'working' ? <Skeleton className="h-10 w-full" aria-label="Confirming" /> : status === 'done' ? (
        <>
          <Alert>
            <AlertDescription>{kind === 'change_email' ? 'Your email address was changed.' : 'Your email address is confirmed.'}</AlertDescription>
          </Alert>
          <p className="text-sm text-muted-foreground">
            <AppLink href="/" className="text-primary">Go to your dashboard</AppLink>
          </p>
        </>
      ) : (
        <>
          <Alert variant="error">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
          <p className="text-sm text-muted-foreground">
            Signed in? You can send a new link from the reminder on your dashboard. <AppLink href="/" className="text-primary">Go to your dashboard</AppLink>
          </p>
        </>
      )}
    </>
  )
}
