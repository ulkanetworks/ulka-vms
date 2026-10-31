import type { Actions } from './actions'
import type { Ctx } from './context'

const TAP = 250 // a first click waits this long for a second

/** Clicking the picture plays or pauses (mouse); a double click seeks on the left and right thirds and goes
 *  fullscreen in the middle. */
export function gestures({ box, video, controls, step, on, later }: Ctx, a: Actions) {
  let timer = 0
  later(() => clearTimeout(timer))
  on(box, 'click', (e) => {
    const p = e as PointerEvent
    if ((p.target as HTMLElement).closest('.shaka-bottom-controls, .shaka-overflow-menu, .ulka-top, button, input, a')) return
    if (timer) {
      clearTimeout(timer)
      timer = 0
      const third = (p.clientX - box.getBoundingClientRect().left) / box.clientWidth
      if (third < 1 / 3) a.seekBy(-step())
      else if (third > 2 / 3) a.seekBy(step())
      else a.toggleFullscreen()
      return
    }
    const mouse = p.pointerType === 'mouse' || !p.pointerType
    timer = window.setTimeout(() => { timer = 0; if (mouse) a.togglePlay() }, TAP)
  })
  on(box, 'pointerdown', () => box.focus({ preventScroll: true }))
  // The pointer leaving the player hides the controls at once while it plays; paused, or with a menu open, they stay.
  on(box, 'pointerleave', (e) => {
    if ((e as PointerEvent).pointerType === 'mouse' && !video.paused && !controls.anySettingsMenusAreOpen()) controls.hideUI()
  })
}
