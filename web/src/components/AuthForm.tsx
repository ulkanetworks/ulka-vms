import { useState, type ComponentProps, type FormEvent } from 'react'
import { useRouterState } from '@tanstack/react-router'
import * as v from 'valibot'
import * as rule from '@/lib/schemas'
import { api } from '@/lib/api'
import { message, say } from '@/lib/messages'
import { rules } from '@/lib/rules'
import { AppLink, useGo } from '@/components/AppLink'
import { AuthHeading } from '@/components/AuthShell'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const go = useGo()
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>
  // Only same-site paths, so a crafted link can't send someone elsewhere after they sign in.
  const asked = typeof search.next === 'string' ? search.next : '/'
  const next = asked.startsWith('/') && !asked.startsWith('//') && !asked.startsWith('/\\') ? asked : '/'

  const [form, setForm] = useState({ name: '', tenantName: '', email: '', password: '' })
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  const signup = mode === 'signup'

  async function submit(e: FormEvent) {
    e.preventDefault()
    setFailure('')
    const schema = v.object(signup ? { name: rule.name(), email: rule.email(), password: rule.newPassword(), tenant_name: rule.name() } : { email: rule.email(), password: rule.currentPassword })
    const parsed = v.safeParse(schema, { email: form.email, password: form.password, ...(signup ? { tenant_name: form.tenantName, name: form.name } : {}) })
    setProblems(parsed.success ? {} : rule.problemsOf(parsed.issues))
    if (!parsed.success) return
    setBusy(true)
    try {
      await api('POST', signup ? '/v1/signup' : '/v1/login', parsed.output)
      go(next)
    } catch (err) {
      setFailure(message(err))
    } finally {
      setBusy(false)
    }
  }

  // One labelled row; the control is built here so every field reads the same.
  const row = (k: keyof typeof form, problem: string | undefined, label: string, props: ComponentProps<typeof Input>) => (
    <Field invalid={!!problem}>
      <FieldLabel htmlFor={k}>{label}</FieldLabel>
      <Input id={k} value={form[k]} onChange={set(k)} aria-invalid={(!!problem) ? true : undefined} {...props} />
      {problem && <FieldError>{problem}</FieldError>}
    </Field>
  )

  // Sign-up closed: only invites bring people in, so the form would only fail.
  if (signup && !rules.signup_open) {
    return (
      <>
        <AuthHeading title="Create account" description={say('signup_closed')} />
        <p className="text-sm text-muted-foreground">
          Already have an account?{' '}
          <AppLink href="/login" className="text-primary">
            Sign in
          </AppLink>
        </p>
      </>
    )
  }

  return (
    <>
      <AuthHeading title={signup ? 'Create account' : 'Sign in'} />

      {failure && (
        <Alert variant="error">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={submit} noValidate>
        <div className="flex flex-col gap-4">
          {signup && row('name', problems.name, 'Your name', { autoComplete: 'name', placeholder: 'Jane Doe' })}
          {signup && row('tenantName', problems.tenant_name, 'Organisation', { autoComplete: 'organization', placeholder: 'Acme Inc.' })}
          {row('email', problems.email, 'Email', { type: 'email', autoComplete: 'email', placeholder: 'you@company.com' })}
          {row('password', problems.password, 'Password', { type: 'password', autoComplete: signup ? 'new-password' : 'current-password', placeholder: signup ? 'At least 12 characters' : 'Your password' })}
          {!signup && (
            <AppLink href="/forgot-password" className="justify-self-start text-sm text-primary">
              Forgot your password?
            </AppLink>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Spinner />}
            {signup ? 'Create account' : 'Sign in'}
          </Button>
        </div>
      </form>

      {signup ? (
        <p className="text-sm text-muted-foreground">
          Already have an account?{' '}
          <AppLink href={`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`} className="text-primary">
            Sign in
          </AppLink>
        </p>
      ) : (
        rules.signup_open && (
          <p className="text-sm text-muted-foreground">
            No account yet?{' '}
            <AppLink href="/signup" className="text-primary">
              Create one
            </AppLink>
          </p>
        )
      )}
    </>
  )
}
