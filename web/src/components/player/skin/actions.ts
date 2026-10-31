import { clock } from '../time'
import { playable, type Ctx } from './context'

export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] // the design's quarter steps, to 2x
const CLOSE = 800 // indicators close 800 ms after the last action
const PERCENT = new Intl.NumberFormat(undefined, { style: 'percent' })

export type Actions = ReturnType<typeof actions>

/** What keys and gestures do, each with on-screen feedback: the playback bubble in the middle, seeking at the sides,
 *  volume and toggles as a pill at the top. */
export function actions({ box, video, controls, el, icon, later }: Ctx) {
  const layer = el('ulka-indicators')
  const seek = el('ulka-ind-seek', layer)
  const seekIcon = el('ulka-ind-icon', seek, 'span')
  const seekValue = el('ulka-ind-value', seek, 'span')
  const play = el('ulka-ind-play', layer)
  el('ulka-ring', play, 'span')
  const playIcon = el('ulka-ind-icon', play, 'span')
  // The notice at the top (Figma: Brightness, nodes 47:2449 and 47:2493): a glass pill with an icon and either a level
  // bar (volume) or a short label.
  const pill = el('ulka-ind-pill', layer)
  el('ulka-ring', pill, 'span')
  const pillIcon = el('ulka-ind-icon', pill, 'span')
  const pillBar = el('ulka-ind-bar', pill, 'span')
  const pillValue = el('ulka-ind-value', pill, 'span')
  const timers = new Map<HTMLElement, number>()
  later(() => { for (const t of timers.values()) clearTimeout(t); layer.remove() })
  const flash = (ind: HTMLElement) => {
    ind.setAttribute('data-open', '')
    clearTimeout(timers.get(ind))
    timers.set(ind, window.setTimeout(() => ind.removeAttribute('data-open'), CLOSE))
  }
  const status = (kind: string, label: string) => {
    pill.dataset.kind = kind
    pillIcon.innerHTML = icon(kind)
    pill.style.removeProperty('--ulka-fill')
    pillValue.textContent = label
    flash(pill)
  }
  let sum = 0

  return {
    // Rapid steps the same way add up ("20s").
    seekBy(secs: number) {
      const dir = secs < 0 ? 'backward' : 'forward'
      const r = playable(controls, video)
      const to = Math.max(r.start, Math.min(r.end, video.currentTime + secs))
      if (to === video.currentTime) return
      video.currentTime = to
      sum = seek.hasAttribute('data-open') && seek.dataset.direction === dir ? sum + Math.abs(secs) : Math.abs(secs)
      seek.dataset.direction = dir
      seekIcon.innerHTML = icon(secs < 0 ? 'seekBackward' : 'seekForward')
      seekValue.textContent = `${sum}s`
      flash(seek)
    },
    seekTo(pct: number) {
      const r = playable(controls, video)
      if (r.end <= r.start) return
      const to = r.start + ((r.end - r.start) * pct) / 100
      seek.dataset.direction = to < video.currentTime ? 'backward' : 'forward'
      seekIcon.innerHTML = icon(to < video.currentTime ? 'seekBackward' : 'seekForward')
      video.currentTime = to
      sum = 0
      // Live: how far behind live it lands; otherwise where in the video.
      seekValue.textContent = r.live ? (r.end - to < 1 ? 'Live' : `-${clock(r.end - to, r.end - r.start)}`) : clock(to, r.end)
      flash(seek)
    },
    togglePlay() {
      if (video.paused || video.ended) void video.play().catch(() => undefined)
      else video.pause()
      play.dataset.status = video.paused ? 'pause' : 'play'
      playIcon.innerHTML = icon(video.paused ? 'pause' : 'play')
      flash(play)
    },
    volumeTo(v: number, muted = video.muted) {
      video.volume = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100
      video.muted = muted
      pill.dataset.kind = 'volume'
      // Muted, silent, low or high, as the design's volume icons.
      pillIcon.innerHTML = icon(video.muted ? 'volumeOff' : video.volume === 0 ? 'volumeNone' : video.volume < 0.5 ? 'volumeLow' : 'volumeHigh')
      pill.style.setProperty('--ulka-fill', `${video.muted ? 0 : video.volume * 100}%`)
      pillBar.setAttribute('aria-hidden', 'true')
      pillValue.textContent = video.muted ? 'Muted' : PERCENT.format(video.volume) // read out, not shown: the bar says it
      flash(pill)
    },
    toggleCaptions() {
      const b = box.querySelector<HTMLButtonElement>('.ulka-captions:not([hidden])')
      if (!b) return
      b.click()
      const on = b.getAttribute('aria-pressed') === 'true'
      status(on ? 'CLOSED_CAPTIONS' : 'CLOSED_CAPTIONS_OFF', on ? 'Captions on' : 'Captions off')
    },
    toggleFullscreen() {
      const was = controls.isFullScreenEnabled()
      void controls.toggleFullScreen()
      status(was ? 'EXIT_FULLSCREEN' : 'fullscreen', was ? 'Exit fullscreen' : 'Fullscreen')
    },
    togglePip() {
      const was = document.pictureInPictureElement === video
      void controls.togglePiP()
      status('pictureInPicture', was ? 'Exit picture in picture' : 'Picture in picture')
    },
    rate(dir: 1 | -1) {
      const next = dir > 0 ? RATES.find((r) => r > video.playbackRate) : [...RATES].reverse().find((r) => r < video.playbackRate)
      if (next !== undefined) video.playbackRate = next
    },
  }
}
