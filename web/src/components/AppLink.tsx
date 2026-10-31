import { Link, useNavigate } from '@tanstack/react-router'
import type { ComponentProps } from 'react'
import { crossHost } from '@/lib/rules'

const external = (href: string) => /^(https?:)?\/\/|^mailto:|^tel:/.test(href)

// "/x?tab=logs#top" -> the router wants the path, the query as an object and the hash apart.
function split(href: string) {
  const [rest, hash] = href.split('#')
  const [to, query = ''] = rest.split('?')
  return { to: to as never, search: Object.fromEntries(new URLSearchParams(query)) as never, hash: hash || undefined }
}

type Props = Omit<ComponentProps<'a'>, 'href'> & { href: string; replace?: boolean }

/** A link by plain address: inside the app it navigates without a reload, outside it is an ordinary anchor. */
export function AppLink({ href: to, replace, children, ...rest }: Props) {
  const href = crossHost(to)
  if (external(href)) return <a href={href} {...rest}>{children}</a>
  // Route paths are typed per route; links here come as strings, so the type is relaxed once, here.
  return (
    <Link {...split(href)} replace={replace} {...(rest as object)}>
      {children}
    </Link>
  )
}

/** Imperative navigation by plain address, e.g. `go('/videos/abc?tab=logs')`. */
export function useGo() {
  const navigate = useNavigate()
  return (to: string, opts?: { replace?: boolean }) => {
    const href = crossHost(to)
    if (external(href)) window.location.assign(href)
    else void navigate({ ...split(href), replace: opts?.replace })
  }
}
