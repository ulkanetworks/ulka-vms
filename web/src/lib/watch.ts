import { notFound } from '@tanstack/react-router'

// The watch page's address: two ids, and the options after them.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Address options: ?template=background (the API's templates), then docs.ulka.co's autoplay, loop, muted, controls,
 *  preload (true or false) and t=30, each overriding what came before. */
export type WatchSearch = { token?: string; template?: string; autoplay?: boolean; loop?: boolean; muted?: boolean; controls?: boolean; preload?: boolean; t?: number }

export const watchSearch = (s: Record<string, unknown>) =>
  ({
    // Kept in the address so a reload still plays a signed video.
    ...(typeof s.token === 'string' && s.token ? { token: s.token } : {}),
    ...(typeof s.template === 'string' && s.template ? { template: s.template } : {}),
    ...Object.fromEntries((['autoplay', 'loop', 'muted', 'controls', 'preload'] as const).filter((k) => s[k] !== undefined).map((k) => [k, s[k] === true || s[k] === 'true' || s[k] === 1 || s[k] === '1'])),
    ...(Number(s.t) > 0 ? { t: Number(s.t) } : {}),
  }) as WatchSearch

/** Anything but two ids (a mistyped console address) is not a video page. */
export const checkIds = ({ params }: { params: { lib: string; video: string } }) => {
  if (!UUID.test(params.lib) || !UUID.test(params.video)) throw notFound()
}
