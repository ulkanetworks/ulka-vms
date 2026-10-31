import { useNavigate } from '@tanstack/react-router'

/** Sets query parameters on the current page, removing the empty ones. */
export function useSetParams() {
  const navigate = useNavigate()
  return (changes: Record<string, string>) =>
    // Search params are untyped on purpose: each page reads the ones it knows from the URL.
    void navigate({
      to: '.',
      replace: true,
      resetScroll: false,
      viewTransition: false, // a filter or a period changing in place, not a new page: no fade on every keystroke
      search: ((prev: Record<string, unknown>) => {
        const next = { ...prev }
        for (const [k, v] of Object.entries(changes)) {
          if (v) next[k] = v
          else delete next[k]
        }
        return next
      }) as never,
    })
}
