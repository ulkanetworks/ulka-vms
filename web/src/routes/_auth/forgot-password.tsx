import { useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import * as v from 'valibot'
import * as schema from '@/lib/schemas'
import { api } from '@/lib/api'
import { message } from '@/lib/messages'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AppLink } from '@/components/AppLink'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Meta } from '@/components/Meta'
import { AuthHeading } from '@/components/AuthShell'
import { Input } from '@/components/ui/input'

export const Route = createFileRoute('/_auth/forgot-password')({
  component: Page,
})

function Page() {
  const [email, setEmail] = useState('')
  const [problem, setProblem] = useState('')
  const [failure, setFailure] = useState('')
  const [sent, setSent] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setFailure('')
    const parsed = v.safeParse(schema.email(), email)
    setProblem(parsed.success ? '' : parsed.issues[0].message)
    if (!parsed.success) return
    setBusy(true)
    try {
      await api('POST', '/v1/password-reset', { email: parsed.output })
      setSent(parsed.output)
    } catch (err) {
      setFailure(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Meta title="Reset your password" description="Get a link to choose a new password." />
      <AuthHeading title="Reset password" />

      {sent ? (
        <Alert>
          <AlertDescription>If {sent} has an account, a link is on its way. It works for one hour.</AlertDescription>
        </Alert>
      ) : (
        <>
          {failure && (
            <Alert variant="error">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          <form onSubmit={submit} noValidate>
            <div className="flex flex-col gap-4">
              <Field invalid={!!problem}>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={(!!problem) ? true : undefined} />
                <FieldError>{problem}</FieldError>
              </Field>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Spinner />}Send link
              </Button>
            </div>
          </form>
        </>
      )}

      <p className="text-sm text-muted-foreground">
        Remembered it? <AppLink href="/login" className="text-primary">Sign in</AppLink>
      </p>
    </>
  )
}
