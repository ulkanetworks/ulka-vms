import { useEffect, useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import * as v from 'valibot'
import * as rule from '@/lib/schemas'
import { api, type InviteLookup, type Me } from '@/lib/api'
import { message } from '@/lib/messages'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AppLink, useGo } from '@/components/AppLink'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Meta } from '@/components/Meta'
import { AuthHeading } from '@/components/AuthShell'
import { Input } from '@/components/ui/input'

export const Route = createFileRoute('/_auth/invite')({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === 'string' ? s.token : '',
  }),
  component: Page,
})

function Page() {
  const { token } = Route.useSearch()
  const go = useGo()
  const here = `/invite?token=${encodeURIComponent(token)}`
  const [invite, setInvite] = useState<InviteLookup | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [problems, setProblems] = useState<Record<string, string>>({})

  useEffect(() => {
    api<InviteLookup>('GET', `/v1/invites/lookup?token=${encodeURIComponent(token)}`)
      .then(setInvite)
      .catch((err) => setFailure(message(err)))
    api<Me>('GET', '/v1/me')
      .then(setMe)
      .catch(() => {}) // not signed in is the usual case
  }, [token])

  const signedInAsInvitee = !!me?.user && !!invite && me.user.email.toLowerCase() === invite.email.toLowerCase()

  async function accept(body: Record<string, string>) {
    setBusy(true)
    setFailure('')
    try {
      await api('POST', '/v1/invites/accept', { token, ...body })
      go('/')
    } catch (err) {
      setFailure(message(err))
    } finally {
      setBusy(false)
    }
  }
  function create(e: FormEvent) {
    e.preventDefault()
    const parsed = v.safeParse(v.object({ name: rule.name(), password: rule.newPassword() }), { name, password })
    setProblems(parsed.success ? {} : rule.problemsOf(parsed.issues))
    if (parsed.success) void accept(parsed.output)
  }
  async function signOut() {
    await api('POST', '/v1/logout').catch(() => {})
    go(`/login?next=${encodeURIComponent(here)}`)
  }

  return (
    <>
      <Meta title="Join a workspace" description="Accept an invitation to an Ulka VMS workspace." />
      {!invite ? (
        <>
          <AuthHeading title="Join a workspace" />
          {failure ? (
            <Alert variant="error">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : (
            <Skeleton className="h-32 w-full" aria-label="Checking your invite" />
          )}
        </>
      ) : (
        <>
          <AuthHeading title={`Join ${invite.tenant_name}`} />
          {failure && (
            <Alert variant="error">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}

          {signedInAsInvitee ? (
            <Button className="w-full" disabled={busy} onClick={() => accept({})}>
              {busy && <Spinner />}Join {invite.tenant_name}
            </Button>
          ) : me?.user ? (
            <>
              <Alert>
                <AlertDescription>
                  You're signed in as {me.user.email}, but this invite is for {invite.email}.
                </AlertDescription>
              </Alert>
              <Button variant="secondary" className="w-full" onClick={signOut}>
                Sign out and switch account
              </Button>
            </>
          ) : invite.account_exists ? (
            <>
              <p className="text-sm text-muted-foreground">{invite.email} already has an account. Sign in to accept.</p>
              <Button className="w-full" onClick={() => go(`/login?next=${encodeURIComponent(here)}`)}>Sign in</Button>
              <p className="text-sm text-muted-foreground">
                <AppLink href="/forgot-password" className="text-primary">Forgot your password?</AppLink>
              </p>
            </>
          ) : (
            <form onSubmit={create} noValidate>
              <div className="flex flex-col gap-4">
                <Field invalid={!!problems.name}>
                  <FieldLabel htmlFor="name">Your name</FieldLabel>
                  <Input id="name" autoComplete="name" placeholder="Jane Doe" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={(!!problems.name) ? true : undefined} />
                  <FieldError>{problems.name}</FieldError>
                </Field>
                <Field invalid={!!problems.password}>
                  <FieldLabel htmlFor="password">Choose a password</FieldLabel>
                  <Input id="password" type="password" autoComplete="new-password" placeholder="At least 12 characters" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={(!!problems.password) ? true : undefined} />
                  <FieldDescription>12 to 72 characters. A few unrelated words work well.</FieldDescription>
                  <FieldError>{problems.password}</FieldError>
                </Field>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy && <Spinner />}Create account and join
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </>
  )
}
