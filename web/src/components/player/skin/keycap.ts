/** Plays one press on a keycap (CSS `[data-press]`), restarting it if it is already pressing. */
export function press(key: Element, delay = 0) {
  if (!(key instanceof HTMLElement)) return
  key.removeAttribute('data-press')
  key.style.setProperty('--ulka-press-delay', `${delay}ms`)
  void key.offsetWidth
  key.setAttribute('data-press', '')
}

// What a key press is called on its keycap, so a real press can find the key on screen.
export const keyLabel = (key: string) =>
  ({ ' ': '␣', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Enter: '↵', Escape: 'Esc' })[key] ?? (/^[0-9]$/.test(key) ? '0–9' : key.length === 1 ? key.toUpperCase() : key)
