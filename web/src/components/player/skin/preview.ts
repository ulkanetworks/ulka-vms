import { clock } from '../time'
import { playable, type Ctx } from './context'

// Shaka's seek bar thumb, in px (range_element.js getValueFromPosition).
const THUMB = 12

/** Above the seek bar: a handle where the pointer is, and the time there in a badge on the storyboard picture's
 *  bottom right (Shaka moves the picture; overlays.css draws both). Listened for on the box, since Shaka rebuilds its
 *  seek bar when settings change. */
export function preview({ box, video, controls, on, el, later }: Ctx) {
  const bar = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>('.shaka-seek-bar-container')
  let lift = 0
  let frame = 0
  const point = (e: Event) => {
    const seek = bar(e.target)
    if (!seek) return
    const view = seek.querySelector<HTMLElement>('.ulka-preview') ?? el('ulka-preview', seek)
    const label = view.querySelector<HTMLElement>('.ulka-preview-label') ?? el('ulka-preview-label', view)
    const time = label.querySelector('.ulka-preview-time') ?? el('ulka-preview-time', label, 'span')
    const r = seek.getBoundingClientRect()
    const x = Math.max(0, Math.min(r.width, (e as PointerEvent).clientX - r.left))
    const w = playable(controls, video)
    // Shaka's mapping (getValueFromPosition): the thumb's centre runs THUMB/2 in from each end, so the time is where a click seeks.
    const share = r.width > THUMB ? Math.max(0, Math.min(1, (x - THUMB / 2) / (r.width - THUMB))) : 0
    const at = w.start + share * (w.end - w.start)
    // A live stream shows how far behind live the pointer is.
    time.textContent = w.live ? (w.end - at < 1 ? 'Live' : `-${clock(w.end - at, w.end - w.start)}`) : clock(at, w.end)
    view.style.setProperty('--ulka-x', `${x}px`)
    // Shaka moves the picture on its own mousemove, after this pointermove: place the badge on it a frame later.
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      const pic = seek.querySelector<HTMLElement>('.shaka-player-ui-thumbnail-container:not(.time-only)')
      const p = pic?.getBoundingClientRect()
      const v = view.getBoundingClientRect()
      // A video without a storyboard (a fresh one) leaves Shaka's card empty: hide it, and the badge stands alone.
      const shown = !!pic && !!p && p.width > 0 && p.height > 8 && getComputedStyle(pic).display !== 'none'
      pic?.toggleAttribute('data-empty', !shown)
      if (shown && pic && p) {
        const inset = 1 + (p.width >= 150 ? 8 : 6) // the card's edge and padding (web or small)
        view.style.setProperty('--ulka-label-x', `${p.right - v.left - inset - label.offsetWidth}px`)
        view.style.setProperty('--ulka-label-y', `${p.bottom - v.top - inset - label.offsetHeight}px`)
        label.setAttribute('data-on-card', '')
      } else {
        // No storyboard: the badge alone, centred on the handle and kept inside the bar.
        const half = label.offsetWidth / 2
        view.style.setProperty('--ulka-label-x', `${Math.max(Math.min(x, r.width - half), half)}px`)
        label.removeAttribute('data-on-card')
      }
    })
    clearTimeout(lift)
    view.setAttribute('data-pointing', '')
  }
  const release = (seek: HTMLElement | null | undefined, after = 0) => {
    clearTimeout(lift)
    lift = window.setTimeout(() => seek?.querySelector('.ulka-preview')?.removeAttribute('data-pointing'), after)
  }
  on(box, 'pointermove', point)
  on(box, 'pointerdown', (e) => { const seek = bar(e.target); if (!seek) return; seek.setAttribute('data-dragging', ''); point(e) })
  on(box, 'pointerout', (e) => {
    const p = e as PointerEvent
    if (p.pointerType === 'mouse' && bar(p.target) && !bar(p.relatedTarget)) release(bar(p.target))
  })
  // A touch shows the handle where the finger is and keeps it a moment after lifting.
  on(window, 'pointerup', (e) => {
    const seek = box.querySelector<HTMLElement>('[data-dragging]')
    seek?.removeAttribute('data-dragging')
    if ((e as PointerEvent).pointerType !== 'mouse') release(seek ?? box.querySelector('.shaka-seek-bar-container'), 600)
  })
  // Shaka rounds a pointer's place on the bar to its step, which it reads as 1 s (the bar says "any"): dragging and the
  // storyboard hopped a second at a time. The step is fine only while Shaka handles the pointer, so the wheel keeps 1 s.
  const input = () => box.querySelector<HTMLInputElement>('.shaka-seek-bar')
  for (const type of ['mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend']) {
    on(window, type, () => { const i = input(); if (i) i.step = '0.001' }, true)
    on(window, type, () => { const i = input(); if (i) i.step = 'any' })
  }
  later(() => { clearTimeout(lift); cancelAnimationFrame(frame); for (const n of box.querySelectorAll('.ulka-preview')) n.remove() })
}
