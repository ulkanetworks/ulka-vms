import type { ReactNode } from 'react'

// The title of a list page, with its primary action on the same line.
export function PageHeader({ title, actions, level = 1 }: { title: ReactNode; actions?: ReactNode; level?: 1 | 2 }) {
  return (
    <header className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      {level === 1 ? <h1 className="min-w-0 truncate text-xl font-semibold">{title}</h1> : <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>}
      {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </header>
  )
}
