import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import 'shaka-player/dist/controls.css'
import './player.css'
import './menu.css'
import './overlays.css'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { RefreshCw } from '@/components/icons'
import type { Chapter, PlayerSettings } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ICONS } from './icons'
import { chaptersVTT, LABELS, layout } from './layout'
import { glyphs, loadShaka, type Shaka } from './shaka'
import { attachSkin } from './skin'

// A live playlist appears a few seconds after the encoder starts; past a minute something is wrong and the viewer is told.
const LIVE_LOAD_EVERY_MS = 2000
const LIVE_LOAD_TRIES = 30

export const defaultPlayer: PlayerSettings = {
  accent: '#10b981', // Ulka green, as the API's default
  theme: 'dark',
  logo_url: '',
  logo_link: '',
  controls: true,
  autoplay: false,
  loop: false,
  muted: false,
  speed: true,
  quality: true,
  captions: true,
  pip: true,
  fullscreen: true,
  skip: 10,
}

type Props = {
  src: string
  poster?: string
  fill?: boolean
  settings?: PlayerSettings
  chapters?: Chapter[]
  /** false hides every control (an embedding page drives the player itself). */
  controls?: boolean
  preload?: 'auto' | 'metadata' | 'none'
  /** Seconds to start from. */
  start?: number
  /** The video element once it exists, for the embed's message bridge. */
  onVideo?: (el: HTMLVideoElement | null) => void
  /** The storyboard's WebVTT index, for pictures above the seek bar. */
  storyboard?: string
  /** A live stream: a failed load is tried again every 2 s (it may not be published yet) instead of failing. */
  live?: boolean
  /** The viewer check's address, offered in the right-click menu. */
  check?: string
  /** The video's name, in the glass bar along the top. */
  title?: string
  /** Where the back button (top left) goes; without it there is no back button. */
  onBack?: () => void
}

/** Back leaves fullscreen first: going back within the same page would otherwise leave the player filling the screen. */
async function back(go: () => void) {
  const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> }
  if (d.fullscreenElement) await d.exitFullscreen().catch(() => undefined)
  else if (d.webkitFullscreenElement) await d.webkitExitFullscreen?.()
  go()
}

export function Player({ src, poster, fill = false, settings, chapters = [], controls = true, preload = 'metadata', start, onVideo, storyboard, live = false, check, title, onBack }: Props) {
  const s = settings ?? defaultPlayer
  const marks = JSON.stringify(chapters)
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const setVideo = useCallback((el: HTMLVideoElement | null) => {
    video.current = el
    onVideo?.(el)
  }, [onVideo])
  const ui = useRef<InstanceType<Shaka['ui']['Overlay']> | null>(null)
  // What the player is doing when it isn't just playing: '' (nothing to say), 'connecting' (a live stream not
  // playable yet), or the sentence to show when it gave up. Every way it can get stuck ends in one of these.
  const [notice, setNotice] = useState('')
  const [attempt, setAttempt] = useState(0)

  // The video and the controls are built once per address (or retry); look and behaviour are applied below without reloading.
  useEffect(() => {
    const el = video.current
    const container = box.current
    if (!el || !container) return
    let gone = false
    let overlay: InstanceType<Shaka['ui']['Overlay']> | null = null
    let vtt = ''
    let detach = () => {}
    setNotice(live ? 'connecting' : '')
    const code = (e: unknown) => (e as { code?: number } | undefined)?.code
    const gaveUp = (why: string, e?: unknown) => { if (!gone) setNotice(code(e) ? `${why} (error ${code(e)})` : why) }
    void loadShaka().then(async (shaka) => {
      if (gone) return
      const player = new shaka.Player()
      overlay = new shaka.ui.Overlay(player, container, el)
      ui.current = overlay
      overlay.getControls()?.getLocalization()?.insert('en', LABELS)
      overlay.configure(layout(s) as never)
      detach = attachSkin(container, overlay.getControls() as never, () => Number(container.dataset.skip) || 10, glyphs(shaka))
      player.addEventListener('error', (e) => {
        const err = (e as CustomEvent<{ severity?: number; code?: number }>).detail
        if (err?.severity === shaka.util.Error.Severity.CRITICAL) gaveUp(live ? 'The stream stopped playing. Try again.' : "This video couldn't load. Check your connection and try again.", err)
      })
      try {
        await player.attach(el)
        // A live stream may not be published yet: its playlist is tried again every 2 s, for up to a minute, then it says so.
        for (let tries = 0; ; tries++) {
          try {
            await player.load(src, start)
            break
          } catch (e) {
            if (gone) return
            if (!live) throw e
            if (tries >= LIVE_LOAD_TRIES) { gaveUp("The stream isn't reaching us. Check that your encoder is streaming, then try again.", e); return }
            await new Promise((r) => setTimeout(r, LIVE_LOAD_EVERY_MS))
            if (gone) return
          }
        }
        if (!gone) setNotice('')
        if (chapters.length && !gone) {
          vtt = URL.createObjectURL(new Blob([chaptersVTT(chapters)], { type: 'text/vtt' }))
          await player.addChaptersTrack(vtt, 'und', 'text/vtt')
          overlay.configure(layout(s, true) as never)
        }
        // A storyboard is made after the video, so a fresh one may not exist yet: the seek bar then shows only the time.
        // Absolute: Shaka finds the sprite with new URL(sprite, storyboard), which refuses a bare path.
        if (storyboard && !gone) await player.addThumbnailsTrack(new URL(storyboard, location.href).href, 'text/vtt').catch((e) => console.warn('storyboard not shown', e?.code ?? e))
      } catch (e) {
        gaveUp("This video couldn't load. Check your connection and try again.", e)
      }
    })
    return () => {
      gone = true
      ui.current = null
      detach()
      void overlay?.destroy()
      if (vtt) URL.revokeObjectURL(vtt)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settings are applied by the effect below
  }, [src, attempt, marks, storyboard, live])

  useEffect(() => {
    const el = video.current
    if (!el) return
    el.loop = s.loop
    el.muted = s.muted || s.autoplay
    el.autoplay = s.autoplay
    if (box.current) box.current.dataset.skip = String(s.skip)
    ui.current?.configure(layout(s, chapters.length > 0) as never)
  }, [s.accent, s.theme, s.loop, s.muted, s.autoplay, s.speed, s.quality, s.captions, s.pip, s.fullscreen, s.skip, src, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  const style = { '--ulka-accent': s.accent } as CSSProperties
  const logo = s.logo_url && <img src={s.logo_url} alt="" className="max-h-8 max-w-24 object-contain" />

  return (
    <div className={cn('relative', fill ? 'h-full' : 'aspect-video')} style={style}>
      {/* One clipped layer holds the background and the controls; clip-path also clips the video's own GPU layer, which overflow ignores. */}
      <div
        ref={box}
        data-skip={s.skip}
        data-theme={s.theme}
        data-controls={controls && s.controls !== false}
        data-check={check}
        data-logo={!!logo || undefined}
        // Shaka adds its own classes here, so what changes at runtime is a data attribute: a new className would wipe them.
        className={cn('ulka-player size-full overflow-hidden bg-black data-[controls=false]:[&_.shaka-controls-container]:!hidden data-[controls=false]:[&_.shaka-spinner-container]:!hidden', !fill && 'rounded-xl [clip-path:inset(0_round_var(--radius-xl))]')}
      >
        <video ref={setVideo} playsInline poster={poster} preload={preload} className="block size-full object-contain" />
        {/* Inside the box, so it stays in fullscreen and comes and goes with the controls (player.css). */}
        <PlayerTop title={title} onBack={onBack} />
      </div>
      {logo && (
        <div className="pointer-events-none absolute top-3 right-3 z-[2]">
          {s.logo_link ? (
            <a href={s.logo_link} target="_blank" rel="noopener noreferrer" className="pointer-events-auto block">
              {logo}
            </a>
          ) : (
            logo
          )}
        </div>
      )}
      {notice === 'connecting' && (
        <div className={cn('pointer-events-none absolute inset-0 z-[3] grid place-items-center p-4 text-sm text-white/80', !fill && 'rounded-xl')} role="status">
          <span className="flex items-center gap-2 rounded-md bg-black/60 px-3 py-1.5"><Spinner className="size-4" />Connecting to the stream…</span>
        </div>
      )}
      {notice && notice !== 'connecting' && (
        // Over the whole player (its controls can't do anything now), in the dark theme whatever the page's, so it reads on the picture.
        <div className={cn('dark absolute inset-0 z-[3] grid place-items-center bg-background p-4', !fill && 'rounded-xl')}>
          <Alert variant="error" className="flex w-auto max-w-md items-center justify-between gap-3">
            <AlertDescription>{notice}</AlertDescription>
            <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}><RefreshCw />
              Try again
            </Button>
          </Alert>
        </div>
      )}
    </div>
  )
}

/** Along the top: back (when there is somewhere to go), the title, and a slot Shaka's cast button moves into
 *  (skin/pills.ts), shown only while it does. */
function PlayerTop({ title, onBack }: { title?: string; onBack?: () => void }) {
  return (
    <div className="ulka-top">
      {onBack && (
        <button type="button" className="ulka-back" aria-label="Back" onClick={() => void back(onBack)}>
          <span className="contents" dangerouslySetInnerHTML={{ __html: ICONS.arrowLeft }} />
          <span className="ulka-ring" />
        </button>
      )}
      {title && <div className="ulka-title" title={title}><span>{title}</span><span className="ulka-ring" /></div>}
      <div className="ulka-cast"><span className="ulka-ring" /></div>
    </div>
  )
}
