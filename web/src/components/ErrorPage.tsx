import { useState, type ReactNode } from 'react'
import { AppLink } from '@/components/AppLink'
import { ApiError } from '@/lib/api'
import { report } from '@/lib/report'
import { CopyText } from '@/components/CopyText'
import { Meta } from '@/components/Meta'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { CircleAlert, RefreshCw } from '@/components/icons'

// Raw error text ("Internal Error") means nothing to a person, so only "not found" or not picks the words.
export function NotFound() {
  return (
    <Page title="Nothing here" description="This page doesn't exist, or it was moved.">
      <Meta title="Not found" description="This page doesn't exist." />
      <Button render={<AppLink href="/" />}>Go to your dashboard</Button>
    </Page>
  )
}

// Only a failed connection is "can't be reached"; anything else broke on this page, and saying otherwise misleads.
export function Unavailable({ error }: { error: unknown }) {
  if (!(error instanceof ApiError && (error.code === 'network' || error.status >= 500))) return <Crashed error={error} />
  return (
    <Page title="The server can't be reached right now" description="Check your connection and try again. If this keeps happening, the service may be down for a moment.">
      <Meta title="Unavailable" description="The server can't be reached right now." />
      <Button onClick={() => location.reload()}><RefreshCw />Try again</Button>
    </Page>
  )
}

// A crash is reported once, and the page says so with the reference that finds it in the server's log.
function Crashed({ error }: { error: unknown }) {
  const [ref] = useState(() => report(error))
  return (
    <Page title="This page couldn't be shown" description="Something went wrong, and it has been written to the server's log. Try again. If it keeps happening, give whoever runs this server the reference below.">
      <Meta title="Something went wrong" description="This page couldn't be shown." />
      <p className="text-sm text-muted-foreground">Reference <CopyText value={ref} what="Reference" /></p>
      <Button onClick={() => location.reload()}><RefreshCw />Try again</Button>
    </Page>
  )
}

const Page = ({ title, description, children }: { title: string; description: string; children: ReactNode }) => (
  <main className="min-h-dvh">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CircleAlert />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{children}</EmptyContent>
    </Empty>
  </main>
)
