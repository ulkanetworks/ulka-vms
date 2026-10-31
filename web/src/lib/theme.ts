// The choice lives in localStorage; index.html applies it before first paint so the page never flashes.
export type Theme = 'system' | 'light' | 'dark'
export const THEMES: Theme[] = ['system', 'light', 'dark']
const KEY = 'stream-theme'
const dark = () => window.matchMedia('(prefers-color-scheme: dark)')

export function storedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

// <html class="dark"> in dark mode; "system" follows the OS and keeps following it.
export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'system' ? dark().matches : theme === 'dark')
  try {
    if (theme === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    // Storage can be blocked; the choice still applies for this visit.
  }
}

export function followSystem() {
  dark().addEventListener('change', () => storedTheme() === 'system' && applyTheme('system'))
}
