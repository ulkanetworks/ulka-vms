import { useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import * as v from 'valibot'
import * as schema from '@/lib/schemas'
import { api } from '@/lib/api'
import { message } from '@/lib/messages'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AppLink } from '@/components/AppLink'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Meta } from '@/components/Meta'
import { AuthHeading } from '@/components/AuthShell'
import { Input } from '@/components/ui/input'

export const Route = createFileRoute('/_auth/reset-password')({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === 'string' ? s.token : '',
  }),
  component: Page,
})

function Page() {
  const { token } = Route.useSearch()
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState('')
  const [failure, setFailure] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setFailure('')
    const parsed = v.safeParse(schema.newPassword(), password)
    setProblem(parsed.success ? '' : parsed.issues[0].message)
    if (!parsed.success) return
    setBusy(true)
    try {
      await api('POST', '/v1/password-reset/confirm', {
        token,
        password: parsed.output,
      })
      setDone(true)
    } catch (err) {
      setFailure(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Meta title="Choose a new password" description="Set a new password for your account." />
      <AuthHeading title="Choose a new password" />

      {done ? (
        <>
          <Alert>
            <AlertDescription>Your password was changed.</AlertDescription>
          </Alert>
          <p className="text-sm text-muted-foreground">
            <AppLink href="/login" className="text-primary">Sign in</AppLink>
          </p>
        </>
      ) : !token ? (
        <Alert variant="error">
          <AlertDescription>
            This link is incomplete. Open the link from the email again, or{' '}
            <AppLink href="/forgot-password" className="underline">
              ask for a new one
            </AppLink>
            .
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {failure && (
            <Alert variant="error">
              <AlertDescription>
                {failure}{' '}
                <AppLink href="/forgot-password" className="underline">
                  Get a new link
                </AppLink>
              </AlertDescription>
            </Alert>
          )}
          <form onSubmit={submit} noValidate>
            <div className="flex flex-col gap-4">
              <Field invalid={!!problem}>
                <FieldLabel htmlFor="password">New password</FieldLabel>
                <Input id="password" type="password" autoComplete="new-password" placeholder="At least 12 characters" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={(!!problem) ? true : undefined} />
                <FieldDescription>12 to 72 characters. A few unrelated words work well.</FieldDescription>
                <FieldError>{problem}</FieldError>
              </Field>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Spinner />}Set password
              </Button>
            </div>
          </form>
        </>
      )}
    </>
  )
}
