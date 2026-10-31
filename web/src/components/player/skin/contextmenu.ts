import { clock } from '../time'
import { motion, qualityName, type Ctx } from './context'
import { keyLabel, press } from './keycap'

const EVENTS = ['adaptation', 'variantchanged', 'loaded']
const NUMBER = new Intl.NumberFormat()
const MBPS = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'megabit-per-second', maximumFractionDigits: 1 })

type Page = 'main' | 'about' | 'keys'

/** The right-click menu: Loop, About Ulka Player, Keyboard shortcuts and (on the watch page) Troubleshoot playback, in the settings menu's card and motion. It
 *  opens where the pointer is (or the middle, from the keyboard's menu key) and closes on a click outside or Escape. */
export function contextMenu({ box, video, controls, step, on, el, later }: Ctx) {
  const { easing, fade: FADE, shift: SHIFT } = motion(box)
  const card = el('ulka-menu ulka-context')
  card.hidden = true
  card.setAttribute('role', 'menu')
  const pages = {} as Record<Page, HTMLElement>
  const page = (name: Page, title?: string) => {
    const p = el('ulka-menu-page', card)
    p.dataset.page = name
    if (title) {
      const back = el('ulka-menu-row ulka-menu-back', p, 'button') as HTMLButtonElement
      back.type = 'button'
      back.textContent = title
      back.addEventListener('click', () => go('main'))
    }
    pages[name] = p
    return p
  }

  const main = page('main')
  const row = (label: string, icon: string, cls = '') => {
    const b = el(`ulka-menu-row ${cls}`, main, 'button') as HTMLButtonElement
    b.type = 'button'
    b.dataset.icon = icon
    b.textContent = label
    return b
  }
  // Loop: on or off for this viewing, starting from the library's setting.
  const loop = row('Loop', 'loop', 'ulka-menu-check')
  loop.setAttribute('role', 'menuitemcheckbox')
  const showLoop = () => loop.setAttribute('aria-checked', String(video.loop))
  loop.addEventListener('click', () => { video.loop = !video.loop; showLoop(); close() })
  el('ulka-menu-sep', main).setAttribute('role', 'separator')
  for (const [to, label, icon] of [['about', 'About Ulka Player', 'info'], ['keys', 'Keyboard shortcuts', 'keyboard']] as const) {
    const b = row(label, icon, 'ulka-menu-next')
    b.setAttribute('role', 'menuitem')
    b.addEventListener('click', () => go(to))
  }
  // The watch page's check (data-check on the player), for a viewer whose video won't play.
  const help = row('Troubleshoot playback', 'help')
  help.setAttribute('role', 'menuitem')
  help.addEventListener('click', () => { window.open(box.dataset.check, '_blank', 'noopener'); close() })

  // About: what is playing and how, kept current while the page is open.
  const about = page('about', 'About Ulka Player')
  const facts = el('ulka-facts', about, 'dl')
  const fact = (label: string) => {
    el('ulka-fact-label', facts, 'dt').textContent = label
    return el('ulka-fact-value', facts, 'dd')
  }
  const version = fact('Player version')
  const size = fact('Player size')
  const picture = fact('Video size')
  const quality = fact('Playing')
  const length = fact('Length')
  const codecs = fact('Codecs')
  version.textContent = __PLAYER_BUILD__
  const duration = (s: number) => {
    if (!Number.isFinite(s)) return s === Infinity ? 'Live' : '—'
    const [h, m, sec] = [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s % 60)]
    const Format = (Intl as unknown as { DurationFormat?: new (l?: string, o?: { style: string }) => { format(d: object): string } }).DurationFormat
    return Format ? new Format(undefined, { style: 'narrow' }).format({ hours: h, minutes: m, seconds: sec }) : clock(s, s)
  }
  const fill = () => {
    if (card.hidden || pages.about.hidden) return
    const r = box.getBoundingClientRect()
    size.textContent = `${NUMBER.format(Math.round(r.width))} × ${NUMBER.format(Math.round(r.height))}`
    picture.textContent = video.videoWidth ? `${NUMBER.format(video.videoWidth)} × ${NUMBER.format(video.videoHeight)}` : '—'
    const t = controls.getPlayer()?.getVariantTracks().find((x) => x.active)
    quality.textContent = t && qualityName(t) ? `${qualityName(t)}${t.bandwidth ? ` · ${MBPS.format(t.bandwidth / 1e6)}` : ''}` : '—'
    length.textContent = duration(video.duration)
    codecs.textContent = [t?.videoCodec, t?.audioCodec].filter(Boolean).join(', ') || '—'
  }
  const watchSize = new ResizeObserver(fill)
  watchSize.observe(box)
  const player = controls.getPlayer()
  for (const e of EVENTS) player?.addEventListener(e, fill)
  on(video, 'loadedmetadata', fill)

  // Keyboard shortcuts: what keys.ts does, each with its keys as chips.
  const keysPage = page('keys', 'Keyboard shortcuts')
  const list = el('ulka-keys-list', keysPage, 'dl')
  const shortcuts = () => {
    const s = step()
    return [
      ['Play or pause', ['␣']],
      ['Seek back', ['←'], `${s} s`],
      ['Seek forward', ['→'], `${s} s`],
      ['Volume up', ['↑']],
      ['Volume down', ['↓']],
      ['Mute', ['M']],
      ['Fullscreen', ['↵']],
      ['Picture-in-picture', ['P']],
      ['Captions', ['C']],
      ['Jump to 0–90%', ['0–9']],
      ['Start or end', ['Home', 'End']],
      ['Slower or faster', ['<', '>']],
      ...(box.querySelector('.ulka-back') ? [['Back', ['Esc']]] : []), // on the video's own page
    ] as [string, string[], string?][]
  }
  const fillKeys = () => {
    list.replaceChildren()
    for (const [label, keys, note] of shortcuts()) {
      const dt = el('ulka-key-label', list, 'dt')
      dt.textContent = label
      if (note) el('ulka-key-note', dt, 'span').textContent = note
      const dd = el('ulka-key-keys', list, 'dd')
      for (const k of keys) el('ulka-kbd', dd, 'kbd').textContent = k
    }
  }

  // Moving between pages: the old one fades out with a 10px shift, the new one fades in, the card eases its height.
  const still = matchMedia('(prefers-reduced-motion: reduce)')
  let current: Page = 'main'
  function go(to: Page) {
    const from = pages[current]
    const next = pages[to]
    const h = card.getBoundingClientRect().height
    from.hidden = true
    next.hidden = false
    current = to
    if (to === 'about') fill() // after showing it: fill skips a hidden page
    if (to === 'keys') {
      fillKeys()
      list.querySelectorAll('.ulka-kbd').forEach((k, i) => press(k, 120 + i * 25)) // a quick wave as the page opens
    }
    place()
    if (still.matches) return
    const nh = card.getBoundingClientRect().height
    card.animate([{ height: `${h}px` }, { height: `${nh}px` }], FADE)
    next.animate([{ opacity: 0 }, { opacity: 1 }], FADE)
    next.animate([{ translate: '10px 0' }, { translate: '0 0' }], SHIFT)
    ;(next.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true })
  }

  // Keep the card inside the player: a page taller than the one before would otherwise run off the bottom.
  const place = (x?: number, y?: number) => {
    const b = box.getBoundingClientRect()
    const left = x === undefined ? card.offsetLeft : x - b.left
    const top = y === undefined ? card.offsetTop : y - b.top
    card.style.left = `${Math.max(8, Math.min(left, b.width - card.offsetWidth - 8))}px`
    card.style.top = `${Math.max(8, Math.min(top, b.height - card.offsetHeight - 8))}px`
  }

  let closing = 0
  const close = () => {
    if (card.hidden || closing) return
    card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing, fill: 'forwards' })
    closing = window.setTimeout(() => { closing = 0; card.hidden = true; card.getAnimations().forEach((x) => x.cancel()) }, 120)
  }
  const open = (x: number, y: number) => {
    showLoop()
    help.hidden = !box.dataset.check
    clearTimeout(closing) // a close still finishing must not hide the menu opened after it
    closing = 0
    card.getAnimations().forEach((x) => x.cancel())
    for (const [name, p] of Object.entries(pages)) p.hidden = name !== 'main'
    current = 'main'
    card.hidden = false
    place(x, y)
    if (!still.matches) card.animate([{ opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1 }], { duration: 150, easing })
    ;(main.querySelector('button') as HTMLElement).focus({ preventScroll: true })
  }

  on(box, 'contextmenu', (e) => {
    const m = e as MouseEvent
    m.preventDefault()
    const b = box.getBoundingClientRect()
    // The keyboard's menu key gives no pointer position: open in the middle.
    open(m.clientX || b.left + b.width / 2, m.clientY || b.top + b.height / 2)
  })
  // A press outside closes it; a right-button press is about to reopen it where it is, so it is left to that.
  on(window, 'pointerdown', (e) => { if ((e as PointerEvent).button !== 2 && !card.contains(e.target as Node)) close() }, true)
  on(box, 'keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Escape' || card.hidden) return
    e.stopPropagation()
    if (current !== 'main') go('main')
    else close()
  }, true)
  // On the shortcuts page: hovering a row presses its keys, and a real key press presses its keycap.
  // Hovering a key presses that key alone; hovering what a row does presses its keys one after another.
  let hovered: Element | null = null
  on(list, 'pointerover', (e) => {
    const t = e.target as HTMLElement
    const target = t.closest('.ulka-kbd') ?? t.closest('dt')
    if (!target || target === hovered) return
    hovered = target
    if (target.matches('.ulka-kbd')) press(target)
    else target.nextElementSibling?.querySelectorAll('.ulka-kbd').forEach((k, i) => press(k, i * 80))
  })
  on(list, 'pointerleave', () => { hovered = null })
  on(box, 'keydown', (e) => {
    if (card.hidden || pages.keys.hidden) return
    const label = keyLabel((e as KeyboardEvent).key)
    list.querySelectorAll('.ulka-kbd').forEach((k) => { if (k.textContent === label) press(k) })
  }, true)
  later(() => { clearTimeout(closing); watchSize.disconnect(); for (const e of EVENTS) player?.removeEventListener(e, fill); card.remove() })
}
