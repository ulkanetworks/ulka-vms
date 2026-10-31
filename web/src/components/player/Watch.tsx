import { useEffect, useMemo, useState } from 'react'
import { Player } from '@/components/player/Player'
import { ApiError, type PlayerConfig } from '@/lib/api'
import { message } from '@/lib/messages'
import { useGet } from '@/lib/query'
import { bridge } from '@/lib/embedBridge'
import { loadedPath, loadedToken } from '@/lib/address'
import type { WatchSearch } from '@/lib/watch'

// It moves every 20 seconds, so no single corner can be cropped away.
const SPOTS = ['top: 8%; left: 6%', 'top: 8%; right: 6%', 'bottom: 18%; right: 6%', 'bottom: 18%; left: 6%', 'top: 44%; left: 34%', 'top: 26%; right: 30%'].map((s) =>
  Object.fromEntries(s.split('; ').map((d) => d.split(': '))),
)

/** Ulka's hosted player on the player host: library/video[?token=], in an iframe or on its own. Everything it
 *  loads sits beside it; config.json names those files with the viewer's token already on them. */
export function Watch({ search }: { search: WatchSearch }) {
  const { template, autoplay, loop, muted, controls: showControls, preload, t } = search
  const base = loadedPath.replace(/\/$/, '')
  // The address's choice, then the embedding page's (Player SDK); otherwise the settings decide.
  const [controls, setControls] = useState<boolean | undefined>(showControls)
  const [el, setEl] = useState<HTMLVideoElement | null>(null)
  useEffect(() => (el ? bridge(el, setControls) : undefined), [el])
  // The page that embeds this one, so the library's allowed websites can be checked.
  const ref = useMemo(() => document.referrer, [])
  const config = useGet<PlayerConfig>(`${base}/config.json?ref=${encodeURIComponent(ref)}${template ? `&template=${encodeURIComponent(template)}` : ''}${loadedToken ? `&token=${loadedToken}` : ''}`)
  const c = config.data
  // The signature's `wm`: editing it breaks the signature, and nothing plays. It deters leaks from screen
  // recordings; it doesn't stop someone taking the stream outside this player.
  const watermark = c?.watermark ?? ''
  const [spot, setSpot] = useState(0)
  useEffect(() => {
    if (!watermark) return
    const t = setInterval(() => setSpot((s) => (s + 1) % SPOTS.length), 20_000)
    return () => clearInterval(t)
  }, [watermark])

  // Back only on the video's own page with somewhere to go back to: an embedding website has its own navigation.
  const canGoBack = useMemo(() => window.self === window.top && history.length > 1, [])

  // The viewer check for this exact address, offered on the error screen and in the right-click menu.
  const check = `/check${base}?${loadedToken ? `token=${loadedToken}&` : ''}ref=${encodeURIComponent(ref)}`
  const err = config.error
  const blocked = err instanceof ApiError && err.code === 'domain_not_allowed'
  const missing = err instanceof ApiError && err.status === 404
  const notReady = !!c && c.status !== 'ready' && c.status !== 'complete'
  const words = blocked
    ? "This video can't be played on this website."
    : missing
      ? "This video can't be found. It may have been removed."
      : notReady
        ? "This video isn't ready yet. Try again in a few minutes."
        : err
          ? message(err)
          : ''

  return (
    <div className="fixed inset-0 bg-black">
      <title>{c?.title || 'Video'}</title>
      <meta name="robots" content="noindex" />
      {words ? (
        <div className="grid size-full place-content-center gap-3 p-6 text-center text-white/80">
          <p>{words}</p>
          <a href={check} target="_blank" rel="noopener" className="text-sm text-white/60 underline underline-offset-4 hover:text-white">
            Run a playback check
          </a>
        </div>
      ) : c ? (
        <Player
          settings={{ ...c.settings, ...(controls !== undefined && { controls }), ...(autoplay !== undefined && { autoplay }), ...(loop !== undefined && { loop }), ...(muted !== undefined && { muted }) }}
          src={`${base}/${c.stream}`}
          poster={`${base}/${c.poster}`}
          storyboard={`${base}/${c.storyboard}`}
          chapters={c.chapters}
          preload={preload === undefined ? 'metadata' : preload ? 'auto' : 'none'}
          start={t}
          onVideo={setEl}
          check={check}
          title={c.title || undefined}
          onBack={canGoBack ? () => history.back() : undefined}
          fill
        />
      ) : null}
      {watermark && (
        <span
          aria-hidden="true"
          style={SPOTS[spot]}
          className="pointer-events-none absolute z-[1] px-1.5 py-0.5 font-mono text-[clamp(11px,1.6vw,16px)] text-white/50 select-none [text-shadow:0_0_2px_rgb(0_0_0/0.8)]"
        >
          {watermark}
        </span>
      )}
    </div>
  )
}
