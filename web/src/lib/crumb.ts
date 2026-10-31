import { useEffect } from 'react'
import { createStore } from './store'

export type Step = { label: string; href?: string }

// Detail pages that load their own data name themselves here, so breadcrumbs show a name instead of an id.
// `trail` adds steps after the page's own name (a library's folders); the last one has no link. `lead` adds steps before it (a video's library and folders).
export const crumb = createStore<{ label: string; section: string; trail: Step[]; lead: Step[] }>({ label: '', section: '', trail: [], lead: [] })

export function useCrumb(label: string, section = '', trail: Step[] = [], lead: Step[] = []) {
  const key = JSON.stringify([trail, lead])
  useEffect(() => {
    const [t, l] = JSON.parse(key) as [Step[], Step[]]
    crumb.set({ label, section, trail: t, lead: l })
    return () => crumb.set({ label: '', section: '', trail: [], lead: [] })
  }, [label, section, key])
}
