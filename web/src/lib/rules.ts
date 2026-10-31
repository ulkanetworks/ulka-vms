import { api, type Me, type Meta } from './api'

// The API's rules, loaded once when the console starts (see routes/__root.tsx). Nothing here is decided in the browser.
export const rules: Meta = { roles: [], capabilities: [], products: [], messages: {}, webhook_events: [], player_url: '', console_url: '', docs_url: '', player_demo: '', signup_open: false, limits: {} as Meta['limits'] }

export const loadRules = (m: Meta) => Object.assign(rules, m)

let reading: Promise<unknown> | undefined
/** Reads /v1/meta once, however many routes ask at the same time. */
export const ready = () => (reading ??= api<Meta>('GET', '/v1/meta').then(loadRules))

/** The player host in production, where only the player's pages exist; in development the console's address serves both. */
export function onPlayerHost() {
  if (!rules.player_url || !rules.console_url) return false
  const player = new URL(rules.player_url).origin
  return player === location.origin && player !== new URL(rules.console_url).origin
}

const docsPath = /^\/(docs|changelog)([/?#]|$)/

/** A link's address across hosts: the docs and changelog live on the docs host, everything else on the console's. In
 * development both are one address, and links stay as they are. */
export function crossHost(href: string) {
  if (!href.startsWith('/') || !rules.docs_url || !rules.console_url) return href
  const docs = new URL(rules.docs_url).origin, console = new URL(rules.console_url).origin
  if (docs === console) return href
  if (docsPath.test(href)) return location.origin === docs ? href : docs + href
  return location.origin === docs ? console + href : href
}

/** Whether the API said the caller may do perm; write includes read. */
export const can = (me: Me, perm: string) => {
  const [product, level] = perm.split(':')
  return me.permissions.includes(perm) || (level === 'read' && me.permissions.includes(`${product}:write`))
}

/** A product's name for its id ("video" → "Video"), as `/v1/meta` words it. */
export const productName = (id: string) => rules.products.find((p) => p.id === id)?.name ?? id
