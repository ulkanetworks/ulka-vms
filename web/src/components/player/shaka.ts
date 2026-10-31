import { registerElements } from './elements'

// Shaka's player and its controls load on first use, so pages without video never download them.
export type Shaka = (typeof import('shaka-player/dist/shaka-player.ui'))['default']

/** Shaka's Material icons: exported at runtime but missing from its type file. */
export const glyphs = (shaka: Shaka) => (shaka.ui as unknown as { Enums: { MaterialDesignSVGIcons: Record<string, string> } }).Enums.MaterialDesignSVGIcons

// Shaka sets its buttons' labels and state as el.ariaLabel = … (ARIA reflection), which Firefox only has from 119:
// without it those buttons have no labels, and the icons that follow their state can't. This teaches older engines.
function reflectAria() {
  for (const [prop, attr] of [['ariaLabel', 'aria-label'], ['ariaPressed', 'aria-pressed'], ['ariaHidden', 'aria-hidden']]) {
    if (prop in Element.prototype) continue
    Object.defineProperty(Element.prototype, prop, {
      configurable: true,
      get(this: Element) { return this.getAttribute(attr) },
      set(this: Element, v: string | null) { if (v == null) this.removeAttribute(attr); else this.setAttribute(attr, String(v)) },
    })
  }
}

let loading: Promise<Shaka> | undefined
export function loadShaka() {
  loading ??= import('shaka-player/dist/shaka-player.ui').then(({ default: shaka }) => {
    reflectAria()
    shaka.polyfill.installAll()
    registerElements(shaka)
    return shaka
  })
  return loading
}
