import { ICONS, type IconName } from '../icons'

// What every behaviour gets: the player box, the video, Shaka's controls and small DOM helpers bound to one cleanup.

export type Controls = {
  getVideo(): HTMLVideoElement | null
  getChapters(): { title: string; startTime: number; endTime: number }[] | null
  getPlayer(): {
    getVariantTracks(): { active: boolean; width: number | null; height: number | null; bandwidth: number; videoCodec: string | null; audioCodec: string | null }[]
    isLive(): boolean
    seekRange(): { start: number; end: number }
    addEventListener(type: string, fn: () => void): void
    removeEventListener(type: string, fn: () => void): void
  } | null
  toggleFullScreen(): Promise<void> | void
  togglePiP(): Promise<void> | void
  isFullScreenEnabled(): boolean
  anySettingsMenusAreOpen(): boolean
  hideUI(): void
  hideSettingsMenus(): void
}

/** A quality's name: its short side ("720p" for 1720×720 or a 720×1280 phone video), as the Qualities list says. */
export const qualityName = (t: { width: number | null; height: number | null }) => (t.width && t.height ? `${Math.min(t.width, t.height)}p` : '')

/** What can be watched: the whole video, or a live stream's window ending at the live edge. */
export function playable(controls: Controls, video: HTMLMediaElement) {
  const p = controls.getPlayer()
  if (p?.isLive()) return { ...p.seekRange(), live: true }
  return { start: 0, end: Number.isFinite(video.duration) ? video.duration : 0, live: false }
}

export type Ctx = {
  box: HTMLElement
  video: HTMLVideoElement
  controls: Controls
  /** Seek step in seconds (the library's skip setting). */
  step: () => number
  /** Listens until the skin is detached. */
  on: (target: EventTarget, type: string, fn: (e: Event) => void, capture?: boolean) => void
  /** Appends an element with a class; removed with the skin when its parent is the box. */
  el: (cls: string, parent?: HTMLElement, tag?: string) => HTMLElement
  /** An icon as SVG markup: ours (icons.ts) by name, else Shaka's Material icon of that name. */
  icon: (name: string) => string
  /** Runs on detach. */
  later: (fn: () => void) => void
}

export function makeCtx(box: HTMLElement, controls: Controls, step: () => number, icons: Record<string, string>) {
  const off = new AbortController()
  const undo: (() => void)[] = [() => off.abort()]
  const ctx: Ctx = {
    box,
    video: controls.getVideo()!,
    controls,
    step,
    on: (target, type, fn, capture = false) => target.addEventListener(type, fn, { signal: off.signal, capture }),
    el: (cls, parent = box, tag = 'div') => parent.appendChild(Object.assign(document.createElement(tag), { className: cls })),
    icon: (name) => (name in ICONS ? ICONS[name as IconName] : `<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="${icons[name]}"/></svg>`),
    later: (fn) => undo.push(fn),
  }
  return { ctx, detach: () => { for (const fn of undo) fn() } }
}

/** The skin's script motion on player.css's own curve (`--ulka-ease`), so scripted and CSS motion ease alike. */
export function motion(box: HTMLElement) {
  const easing = getComputedStyle(box).getPropertyValue('--ulka-ease').trim() || 'ease-out'
  return { easing, fade: { duration: 180, easing }, shift: { duration: 220, easing } }
}
