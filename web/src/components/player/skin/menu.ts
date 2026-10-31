import { motion, qualityName, type Ctx } from './context'

// Settings motion: pages crossfade (180 ms) with a 10px shift (220 ms) while the card's height
// eases to the new page (180 ms); the card rises 24px as it opens (220 ms) and drops as it closes (150 ms).
const CLOSE = 150
const EVENTS = ['adaptation', 'variantchanged', 'loaded']
const ROW = 'button:not(.shaka-hidden)'

/** Animates the settings card. Shaka swaps pages, and hides the card, at once with a forced display: none, so the
 *  page or card that leaves is a copy taken just before, animated and then removed. */
export function menu({ box, controls, on, later }: Ctx, onChange: () => void) {
  const { fade: FADE, shift: SHIFT } = motion(box)
  const card = () => box.querySelector<HTMLElement>('.shaka-overflow-menu')
  const page = (c: HTMLElement) => [...c.children].find((x) => x.matches('.shaka-sub-menu:not(.shaka-hidden)')) as HTMLElement | undefined
  const rowsOf = (c: HTMLElement) => {
    const p = page(c)
    return p ? [p] : ([...c.children].filter((x) => x.matches(ROW)) as HTMLElement[])
  }
  const still = matchMedia('(prefers-reduced-motion: reduce)')

  // Just before Shaka changes the page, copy what is on screen so it can fade away.
  let copy: { el: HTMLElement; h: number } | undefined
  on(box, 'click', (e) => {
    const c = card()
    if (!c?.offsetParent || !(e.target as HTMLElement | null)?.closest?.(`.shaka-overflow-menu ${ROW}`)) return
    const el = Object.assign(document.createElement('div'), { className: 'ulka-menu-ghost' })
    el.style.top = `${c.scrollTop}px`
    for (const row of rowsOf(c)) el.appendChild(row.cloneNode(true))
    copy = { el, h: c.getBoundingClientRect().height }
  }, true)

  const leave = (c: HTMLElement) => {
    const gone = c.cloneNode(true) as HTMLElement
    gone.classList.remove('shaka-hidden')
    gone.classList.add('ulka-menu-leaving')
    c.after(gone)
    gone.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 24px' }], { ...SHIFT, duration: CLOSE, fill: 'forwards' })
    setTimeout(() => gone.remove(), CLOSE + 30) // a timer, not onfinish: a hidden tab holds animation events back
  }

  // No gear when the menu would open empty: one quality, one audio, no captions, or a template that turns them off.
  const empty = () => {
    const c = card()
    if (c && page(c)) return // a page is open: Shaka hides the main rows meanwhile, which isn't "empty"
    box.toggleAttribute('data-no-settings', !!c && !c.querySelector(':scope > button:not(.shaka-hidden, .ulka-menu-head)'))
  }
  empty()

  let shown: HTMLElement | null | undefined
  const watch = new MutationObserver(() => {
    empty()
    relabel()
    words()
    chapters()
    head()
    const c = card()
    if (!c?.offsetParent) {
      if (c && shown !== undefined && !still.matches) leave(c)
      shown = copy = undefined
      return
    }
    const now = page(c) ?? null
    if (now === shown) return
    const first = shown === undefined
    shown = now
    onChange()
    // A page opens at its top, scrolled just enough to show what is chosen now.
    c.scrollTop = 0
    const chosen = now?.querySelector<HTMLElement>('.shaka-chosen-item')?.closest<HTMLElement>('button')
    if (chosen && chosen.offsetTop + chosen.offsetHeight > c.clientHeight) c.scrollTop = chosen.offsetTop + chosen.offsetHeight / 2 - c.clientHeight / 2
    const from = copy
    copy = undefined
    if (first || !from || still.matches) return
    const h = c.getBoundingClientRect().height
    c.setAttribute('data-moving', '')
    c.appendChild(from.el)
    c.animate([{ height: `${from.h}px` }, { height: `${h}px` }], FADE)
    from.el.animate([{ opacity: 1 }, { opacity: 0 }], { ...FADE, fill: 'forwards' })
    from.el.animate([{ translate: '0 0' }, { translate: '10px 0' }], SHIFT)
    for (const row of rowsOf(c)) {
      row.animate([{ opacity: 0 }, { opacity: 1 }], FADE)
      row.animate([{ translate: '10px 0' }, { translate: '0 0' }], SHIFT)
    }
    setTimeout(() => { from.el.remove(); c.removeAttribute('data-moving') }, SHIFT.duration + 30)
  })
  watch.observe(box, { subtree: true, attributes: true, attributeFilter: ['class'] })

  // "Auto (540p)": the quality Auto is playing now, beside its name on the Quality page.
  const player = controls.getPlayer()
  const auto = () => {
    const t = player?.getVariantTracks().find((x) => x.active)
    box.style.setProperty('--ulka-auto', t && qualityName(t) ? `" (${qualityName(t)})"` : '""')
  }
  // Shaka names a wider-than-16:9 video by the height it would have at 16:9 (1720×720 as "968p"); rename its rows
  // by the short side, so they match Auto, the About page and the console's Qualities list.
  const relabel = () => {
    const names = new Map<string, string>()
    for (const t of player?.getVariantTracks() ?? []) {
      if (!t.width || !t.height) continue
      const [long, short] = [Math.max(t.width, t.height), Math.min(t.width, t.height)]
      names.set(`${long / short > 16 / 9 ? Math.round((long * 9) / 16) : short}p`, qualityName(t))
    }
    for (const span of box.querySelectorAll<HTMLElement>('.shaka-overflow-menu span')) {
      const m = span.childElementCount ? null : span.textContent?.match(/^(\d+p)(\d*)$/)
      const name = m && names.get(m[1])
      if (name && name !== m[1]) span.textContent = name + m[2]
    }
  }
  // The design's words where Shaka's differ: page titles, and "Turn off" for no subtitles.
  const TITLES: [string, string][] = [['.shaka-resolutions', 'Video Quality'], ['.shaka-text-languages', 'Subtitles'], ['.shaka-playback-rates', 'Playback Speed']]
  const words = () => {
    for (const [page, title] of TITLES) {
      const span = box.querySelector<HTMLElement>(`${page} > .shaka-back-to-overflow-button > span`)
      if (span && span.textContent !== title) span.textContent = title
    }
    const off = box.querySelector<HTMLElement>('.shaka-turn-captions-off-button > span')
    if (off && off.textContent !== 'Turn off') off.textContent = 'Turn off'
  }
  // Chapters: each row's start under its title (00:03:10s), and the one playing now lit.
  const video = controls.getVideo()
  const two = (n: number) => String(Math.floor(n)).padStart(2, '0')
  const chapters = () => {
    const list = controls.getChapters() ?? []
    const rows = box.querySelectorAll<HTMLElement>('.shaka-chapters .shaka-chapter-item')
    const now = video?.currentTime ?? 0
    rows.forEach((row, i) => {
      const c = list[i]
      if (!c) return
      // Added after Shaka's title, never around it: Shaka puts the picture in front of the title once it loads.
      const start = row.querySelector<HTMLElement>('.ulka-chapter-start') ?? row.appendChild(Object.assign(document.createElement('span'), { className: 'ulka-chapter-start' }))
      const text = `${two(c.startTime / 3600)}:${two((c.startTime / 60) % 60)}:${two(c.startTime % 60)}s`
      if (start && start.textContent !== text) start.textContent = text
      row.toggleAttribute('data-current', now >= c.startTime && now < c.endTime)
    })
  }
  // Picking a chapter closes the menu (Shaka goes back to its first page): the viewer chose where to watch from.
  // Listened for on the way down: Shaka's rows stop the click on the way up. Closed once Shaka has handled it.
  on(box, 'click', (e) => {
    if ((e.target as HTMLElement | null)?.closest?.('.shaka-chapters .shaka-chapter-item')) setTimeout(() => controls.hideSettingsMenus(), 50)
  }, true)
  // The small player's menu fills it, so its first page gets a "‹ Settings" row that closes it.
  const head = () => {
    const c = card()
    if (!c || c.querySelector(':scope > .ulka-menu-head')) return
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ulka-menu-head', textContent: 'Settings' })
    b.setAttribute('aria-label', 'Close settings')
    b.addEventListener('click', (e) => { e.stopPropagation(); controls.hideSettingsMenus() })
    c.prepend(b)
  }
  for (const e of EVENTS) player?.addEventListener(e, auto)
  later(() => { watch.disconnect(); for (const e of EVENTS) player?.removeEventListener(e, auto) })
}
