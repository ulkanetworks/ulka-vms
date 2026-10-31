import type { Ctx } from './context'
import { press } from './keycap'

const DELAY = 600 // open after hovering this long, at once while moving between buttons

// What each button's tooltip says and the key it shows.
function tipFor(b: HTMLElement): [string, string] | null {
  const pressed = b.getAttribute('aria-pressed') === 'true'
  if (b.matches('.shaka-play-button')) return [b.getAttribute('aria-label') ?? 'Play', '␣']
  if (b.matches('.ulka-skip')) return [b.getAttribute('aria-label') ?? '', b.dataset.sign === '-1' ? '←' : '→']
  if (b.matches('.ulka-captions')) return [pressed ? 'Disable captions' : 'Enable captions', 'C']
  if (b.matches('.shaka-pip-button')) return [pressed ? 'Exit picture-in-picture' : 'Enter picture-in-picture', 'P']
  if (b.matches('.shaka-fullscreen-button')) return [pressed ? 'Exit fullscreen' : 'Enter fullscreen', '↵']
  if (b.matches('.ulka-back')) return ['Back', 'Esc']
  if (b.matches('.shaka-overflow-menu-button')) return ['Settings', '']
  if (b.matches('.ulka-live')) return [b.hasAttribute('data-behind') ? 'Go to live' : 'Watching live', '']
  return null
}

/** A glass pill 12px above the hovered or keyboard-focused button (below it for the top bar's); returns `hide`. */
export function tooltips({ box, controls, on, el, later }: Ctx) {
  const tip = el('ulka-tip')
  const label = el('ulka-tip-label', tip, 'span')
  const key = el('ulka-tip-key', tip, 'kbd')
  let timer = 0
  let last = 0
  const hide = () => { clearTimeout(timer); if (tip.hasAttribute('data-open')) last = Date.now(); tip.removeAttribute('data-open') }
  const show = (b: HTMLElement) => {
    const t = tipFor(b)
    if (!t || controls.anySettingsMenusAreOpen()) return
    label.textContent = t[0]
    key.textContent = t[1]
    key.hidden = !t[1]
    const r = b.getBoundingClientRect(), c = box.getBoundingClientRect()
    const below = !!b.closest('.ulka-top')
    tip.style.top = below ? `${r.bottom - c.top + 12}px` : ''
    tip.style.bottom = below ? '' : `${c.bottom - r.top + 12}px`
    tip.style.left = `${Math.min(Math.max(r.left + r.width / 2 - c.left, tip.offsetWidth / 2 + 12), c.width - tip.offsetWidth / 2 - 12)}px`
    tip.setAttribute('data-open', '')
    if (t[1]) press(key, 60)
  }
  const target = (e: Event) => (e.target as HTMLElement).closest?.<HTMLElement>('.shaka-bottom-controls button, .ulka-back')
  on(box, 'pointerover', (e) => {
    const b = target(e)
    if (!b || (e as PointerEvent).pointerType === 'touch') return // a tap must not leave a tooltip floating
    clearTimeout(timer)
    timer = window.setTimeout(() => show(b), Date.now() - last < 400 ? 0 : DELAY)
  })
  on(box, 'pointerout', (e) => { if (target(e)) hide() })
  on(box, 'focusin', (e) => { const b = target(e); if (b && box.classList.contains('ulka-keys')) show(b) })
  on(box, 'focusout', hide)
  on(box, 'click', hide, true)
  later(() => { clearTimeout(timer); tip.remove() })
  return hide
}
