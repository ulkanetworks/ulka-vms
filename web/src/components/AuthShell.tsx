import type { ReactNode } from 'react'
import { Logo } from '@/components/Logo'
import { Section } from '@/components/Section'

// Every sign-in style page: one centred column, logo above the form's card, footer below.
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 py-10">
      <div className="grid w-full max-w-sm flex-1 content-center gap-8">
        <Logo href="/" className="justify-self-center" />
        <Section bodyClassName="grid gap-6 p-6">{children}</Section>
      </div>
      <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} Ulka VMS</p>
    </main>
  )
}

/** The heading every page starts with. */
export function AuthHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="grid gap-1">
      <h1 className="text-lg font-semibold">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </header>
  )
}
