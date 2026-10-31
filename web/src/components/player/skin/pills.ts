import type { Ctx } from './context'

// The design's controls are glass pills: play, the skips and volume; the time and seek bar; the chapter (its own
// pill, elements.ts); settings, picture-in-picture, fullscreen and the mark. Shaka builds its controls as one flat
// row, so after it builds (and whenever it rebuilds, as configure() does) its items are moved into the pills, in
// this order, and its cast button into the top bar's round slot (Player.tsx). Shaka keeps its own references to
// the items, so moving them changes nothing it does.
const PILLS: [string, string[]][] = [
  ['ulka-pill-play', ['.shaka-play-button', '.ulka-skip', '.shaka-mute-volume-container']],
  ['ulka-pill-time', ['.ulka-live', '.ulka-current', '.shaka-seek-bar-container', '.ulka-remaining']],
  ['', ['.ulka-chapter']],
  ['ulka-pill-tools', ['.ulka-captions', '.shaka-overflow-menu-button', '.shaka-pip-button', '.shaka-fullscreen-button', '.ulka-brand']],
]

export function pills({ box, later }: Ctx) {
  const group = () => {
    const bar = box.querySelector<HTMLElement>('.shaka-bottom-controls')
    const panel = bar?.querySelector<HTMLElement>('.shaka-controls-button-panel')
    if (!bar || !panel) return
    const order: HTMLElement[] = []
    for (const [name, items] of PILLS) {
      let pill = name ? panel.querySelector<HTMLElement>(`:scope > .${name}`) : null
      if (name && !pill) {
        pill = Object.assign(document.createElement('div'), { className: `ulka-pill ${name}` })
        pill.append(Object.assign(document.createElement('span'), { className: 'ulka-ring' }))
      }
      // The chapter is a pill already (elements.ts), so it only takes its place in the order below.
      if (pill) for (const sel of items) for (const item of bar.querySelectorAll<HTMLElement>(sel)) if (item.parentElement !== pill) pill.appendChild(item)
      const node = pill ?? bar.querySelector<HTMLElement>('.ulka-chapter')
      if (node) order.push(node)
    }
    // The pills last in the panel, in the design's order; moved only when they aren't already.
    const tail = [...panel.children].slice(-order.length)
    if (order.some((node, i) => tail[i] !== node)) panel.append(...order)
    // On phones Shaka adds a big play/pause button in the middle: it gets the glass's ring and an icon box of our own
    // (player.css draws the design's icons in it by the button's label; Shaka only redraws its own svg).
    const big = box.querySelector<HTMLElement>('.shaka-big-buttons-container .shaka-play-button')
    if (big && !big.querySelector(':scope > .ulka-big-icon')) {
      big.append(Object.assign(document.createElement('span'), { className: 'ulka-big-icon' }), Object.assign(document.createElement('span'), { className: 'ulka-ring' }))
    }
    const cast = box.querySelector<HTMLElement>('.shaka-remote-button')
    const slot = box.querySelector<HTMLElement>('.ulka-cast')
    if (cast && slot && cast.parentElement !== slot) slot.prepend(cast)
  }
  let busy = false
  const watch = new MutationObserver(() => {
    if (busy) return
    busy = true
    group()
    watch.takeRecords() // our own moves
    busy = false
  })
  group()
  watch.observe(box, { childList: true, subtree: true })
  later(() => watch.disconnect())
}
