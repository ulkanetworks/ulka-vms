// Our own items in Shaka's control bar, registered once by name for `layout()`.
import { ICONS } from './icons'
import { glyphs, type Shaka } from './shaka'
import { playable } from './skin/context'
import { clock } from './time'

type Parent = HTMLElement
type Controls = InstanceType<Shaka['ui']['Controls']>

export function registerElements(shaka: Shaka) {
  const register = (name: string, build: (parent: Parent, controls: Controls, element: InstanceType<Shaka['ui']['Element']>) => void) =>
    shaka.ui.Controls.registerElement(name, {
      create: (parent: Parent, controls: Controls) =>
        new (class extends shaka.ui.Element {
          constructor() {
            super(parent, controls)
            build(parent, controls, this)
          }
        })(),
    } as never)

  // Shaka's own rewind/fast-forward buttons change speed; ours jump by the library's chosen seconds.
  for (const [name, sign] of [['ulka_back', -1], ['ulka_forward', 1]] as const) {
    register(name, (parent, controls, self) => {
      const seconds = Number(controls.getVideoContainer().dataset.skip) || 0
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ulka-skip', innerHTML: seconds === 10 ? ICONS[sign < 0 ? 'seekBackward10' : 'seekForward10'] : skipIcon(sign, seconds) })
      b.dataset.sign = String(sign)
      b.setAttribute('aria-label', sign < 0 ? `Seek backward ${seconds} seconds` : `Seek forward ${seconds} seconds`)
      self.eventManager?.listen(b, 'click', () => {
        const v = controls.getVideo()!
        const r = playable(controls as never, v)
        v.currentTime = Math.max(r.start, Math.min(r.end || Infinity, v.currentTime + sign * seconds))
      })
      parent.appendChild(b)
    })
  }

  // Ulka's mark, last in the bar: a link to ulka.co in a new tab.
  register('ulka_brand', (parent) => {
    const mark = Object.assign(document.createElement('a'), { className: 'ulka-brand', innerHTML: ICONS.brand, href: 'https://ulka.co', target: '_blank', rel: 'noopener noreferrer' })
    mark.setAttribute('aria-label', 'Ulka (opens ulka.co in a new tab)')
    parent.appendChild(mark)
  })

  // Time either side of the seek bar: elapsed, and the length (clicked: what is left). Each is as wide as its text,
  // as the design has it; the digits are tabular, so the bar moves only when a time gains a digit (9:59 to 10:00).
  for (const [name, remaining] of [['ulka_current', false], ['ulka_remaining', true]] as const) {
    register(name, (parent, controls, self) => {
      const v = controls.getVideo()!
      const el = document.createElement(remaining ? 'button' : 'span')
      el.className = `ulka-time ${remaining ? 'ulka-remaining' : 'ulka-current'}`
      let whole = true
      const show = () => {
        const d = v.duration
        const live = d === Infinity || !!controls.getPlayer()?.isLive()
        const known = Number.isFinite(d) && d > 0
        el.hidden = live // a live stream shows the Live badge instead
        el.toggleAttribute('data-unavailable', !known && !live)
        const now = Number.isFinite(v.currentTime) ? Math.max(0, v.currentTime) : 0
        const span = live ? now : known ? d : 0 // what sets the format: h:mm:ss once it reaches an hour
        const t = !remaining ? now : whole ? span : Math.max(0, span - now)
        const text = (remaining && !whole ? '-' : '') + clock(t, span)
        el.textContent = text
        if (remaining) el.setAttribute('aria-label', whole ? 'Show remaining time' : 'Show duration')
      }
      if (remaining) self.eventManager?.listen(el, 'click', () => { whole = !whole; show() })
      for (const e of ['timeupdate', 'durationchange', 'loadedmetadata', 'seeking', 'seeked', 'emptied']) self.eventManager?.listen(v, e, show)
      show()
      parent.appendChild(el)
    })
  }

  // Live streams: a red dot and "Live"; grey once the viewer is behind, and a press goes back to the live edge.
  register('ulka_live', (parent, controls, self) => {
    const v = controls.getVideo()!
    const player = controls.getPlayer()!
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ulka-live', textContent: 'Live' })
    const show = () => {
      b.hidden = !player.isLive()
      if (b.hidden) return
      // Players sit a few seconds back from the edge on purpose; more than that is "behind".
      const behind = player.seekRange().end - v.currentTime > 8
      b.toggleAttribute('data-behind', behind)
      b.setAttribute('aria-label', behind ? 'Go to live' : 'Watching live')
    }
    self.eventManager?.listen(b, 'click', () => { v.currentTime = player.seekRange().end; if (v.paused) void v.play() })
    for (const e of ['timeupdate', 'seeked', 'loadedmetadata', 'emptied']) self.eventManager?.listen(v, e, show)
    self.eventManager?.listen(player, 'loaded', show)
    show()
    parent.appendChild(b)
  })

  // The chapter playing now, in its own glass pill with a chevron: pressed, it opens the settings menu's Chapters
  // page. Shown only when the video has chapters.
  register('ulka_chapter', (parent, controls, self) => {
    const v = controls.getVideo()!
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ulka-pill ulka-chapter' })
    const name = Object.assign(document.createElement('span'), { className: 'ulka-chapter-name' })
    b.append(name)
    b.insertAdjacentHTML('beforeend', ICONS.chapter)
    b.append(Object.assign(document.createElement('span'), { className: 'ulka-ring' }))
    const show = () => {
      const chapters = controls.getChapters() ?? []
      const now = chapters.find((c) => v.currentTime >= c.startTime && v.currentTime < c.endTime) ?? chapters[0]
      b.hidden = !now
      if (!now || name.textContent === now.title) return
      name.textContent = now.title
      b.setAttribute('aria-label', `Chapter: ${now.title}. Show chapters`)
    }
    // Shaka's own Chapters page, inside the settings menu (layout() adds it whenever there are chapters).
    self.eventManager?.listen(b, 'click', (e) => {
      // Shaka closes its menus on any click that reaches the controls, which would shut this one at once.
      e?.stopPropagation()
      const box = controls.getVideoContainer()
      box.querySelector<HTMLElement>('.shaka-overflow-menu-button')?.click()
      box.querySelector<HTMLElement>('.shaka-overflow-menu .shaka-chapter-button')?.click()
    })
    for (const e of ['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'emptied']) self.eventManager?.listen(v, e, show)
    self.eventManager?.listen(controls, 'chaptersupdated', show)
    show()
    parent.appendChild(b)
  })

  // Captions on or off in one press; shown only while the video has some.
  register('ulka_captions', (parent, controls, self) => {
    const player = controls.getPlayer()!
    const icons = glyphs(shaka)
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'shaka-tooltip ulka-captions' })
    const glyph = new shaka.ui.Icon(b, icons.CLOSED_CAPTIONS_OFF)
    let last: ReturnType<typeof player.getTextTracks>[number] | undefined
    const show = () => {
      const tracks = player.getTextTracks()
      const on = tracks.find((t) => t.active)
      if (on) last = on
      b.hidden = tracks.length === 0
      b.setAttribute('aria-pressed', String(!!on))
      b.setAttribute('aria-label', on ? 'Disable captions' : 'Enable captions')
      glyph.use(on ? icons.CLOSED_CAPTIONS : icons.CLOSED_CAPTIONS_OFF)
    }
    // Shaka 5 has no visibility switch: off is no track, on is the last one chosen.
    self.eventManager?.listen(b, 'click', () => {
      const tracks = player.getTextTracks()
      player.selectTextTrack(tracks.some((t) => t.active) ? null : (tracks.find((t) => t.id === last?.id) ?? tracks[0]))
      show()
    })
    for (const e of ['trackschanged', 'textchanged', 'loaded']) self.eventManager?.listen(player, e, show)
    self.eventManager?.listen(controls, 'captionselectionupdated', show)
    show()
    parent.appendChild(b)
  })
}


// Other skip lengths than 10 s: a circular arrow with the seconds inside (Lucide's rotate arrows).
function skipIcon(sign: -1 | 1, seconds: number) {
  const arrow = sign < 0 ? '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>' : '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${arrow}<text x="12" y="15.2" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">${seconds}</text></svg>`
}
