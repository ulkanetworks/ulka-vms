import type { Actions } from './actions'
import type { Ctx } from './context'

const REPEATABLE = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']

/** Keyboard shortcuts, on the player box so several players on a page don't fight over keys. Also marks
 *  keyboard use (`ulka-keys`): focus rings and focus-opened pop-ups show only then. */
export function keys({ box, video, controls, step, on }: Ctx, a: Actions) {
  on(window, 'keydown', (e) => { if ((e as KeyboardEvent).key === 'Tab') box.classList.add('ulka-keys') }, true)
  on(window, 'pointerdown', () => box.classList.remove('ulka-keys'), true)
  on(box, 'keydown', (e) => {
    const k = e as KeyboardEvent
    const t = k.target as HTMLElement
    if (k.ctrlKey || k.metaKey || k.altKey || t.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.matches('input[type=range]'))) return
    const onSlider = t.matches('input[type=range]')
    const key = k.key.length === 1 ? k.key.toLowerCase() : k.key
    if (k.repeat && !REPEATABLE.includes(key)) return
    // Space plays or pauses wherever focus is, even on a button the pointer last pressed (fullscreen, say), except
    // in a menu, where it picks the row. Enter presses a focused button or link. Esc first closes an open menu.
    const onControl = /^(BUTTON|A)$/.test(t.tagName)
    const inMenu = !!t.closest('.shaka-overflow-menu, .shaka-context-menu, .ulka-menu')
    if ((key === ' ' && inMenu) || (key === 'Enter' && onControl)) return
    if (key === 'Escape' && controls.anySettingsMenusAreOpen()) return
    const back = box.querySelector<HTMLButtonElement>('.ulka-back')
    const act: Record<string, (() => void) | undefined> = {
      ' ': a.togglePlay,
      m: () => a.volumeTo(video.volume, !video.muted),
      Enter: a.toggleFullscreen,
      c: a.toggleCaptions,
      p: a.togglePip,
      Escape: back ? () => back.click() : undefined, // in fullscreen the browser takes Esc to leave it
      ArrowRight: onSlider ? undefined : () => a.seekBy(step()),
      ArrowLeft: onSlider ? undefined : () => a.seekBy(-step()),
      ArrowUp: onSlider ? undefined : () => a.volumeTo(video.volume + 0.05, false),
      ArrowDown: onSlider ? undefined : () => a.volumeTo(video.volume - 0.05, false),
      Home: () => a.seekTo(0),
      End: () => a.seekTo(100),
      '>': () => a.rate(1),
      '<': () => a.rate(-1),
    }
    const run = /^[0-9]$/.test(key) ? () => a.seekTo(Number(key) * 10) : act[key]
    if (!run) return
    run()
    k.preventDefault()
    k.stopPropagation()
  }, true)
  // A button presses itself when Space is let go, so that is stopped too (outside menus), or Space would play and then
  // press the focused button.
  on(box, 'keyup', (e) => {
    const k = e as KeyboardEvent
    const t = k.target as HTMLElement
    if (k.key === ' ' && t.tagName === 'BUTTON' && !t.closest('.shaka-overflow-menu, .shaka-context-menu, .ulka-menu')) k.preventDefault()
  }, true)
}
