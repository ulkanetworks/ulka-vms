import { playable, type Ctx } from './context'

/** The seek bar's paint (player.css): what has played (--ulka-played), drawn by us every frame since Shaka repaints
 *  its bar only 8 times a second, which moved a short video's playhead in visible steps; what has loaded ahead of it
 *  (--ulka-loaded); and a 4px cut at each chapter (--ulka-cuts, a mask). While dragging it follows the thumb. */
export function playhead({ box, video, controls, on, later }: Ctx) {
  let frame = 0
  let cuts = ''
  const paint = () => {
    const seek = box.querySelector<HTMLElement>('.shaka-seek-bar-container')
    const input = seek?.querySelector<HTMLInputElement>('input')
    if (!seek || !input) return
    const w = playable(controls, video)
    const span = w.end - w.start
    const part = (t: number) => (span > 0 ? Math.max(0, Math.min(1, (t - w.start) / span)) : 0)
    const at = seek.hasAttribute('data-dragging') ? Number(input.value) : video.currentTime
    seek.style.setProperty('--ulka-played', String(part(at)))
    // The loaded stretch the playhead is in, up to where it ends.
    const b = video.buffered
    let loaded = video.currentTime
    for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.5 && b.end(i) > loaded) loaded = b.end(i)
    seek.style.setProperty('--ulka-loaded', String(part(loaded)))
    const now = cutsOf(controls.getChapters() ?? [], w.start, span)
    if (now !== cuts) seek.style.setProperty('--ulka-cuts', (cuts = now) || 'none')
  }
  const run = () => {
    paint()
    frame = video.paused ? 0 : requestAnimationFrame(run)
  }
  const start = () => { if (!frame) run() }
  for (const type of ['play', 'playing', 'pause', 'seeked', 'seeking', 'durationchange', 'loadedmetadata']) on(video, type, start)
  // Paused, what has loaded and the chapters (added after the video loads) still arrive.
  for (const type of ['progress', 'timeupdate']) on(video, type, paint)
  // After Shaka has moved the thumb for this pointer (its listeners are on the bar and document; this one is last).
  for (const type of ['mousemove', 'mouseup', 'touchmove', 'touchend', 'input']) on(window, type, paint)
  start()
  later(() => cancelAnimationFrame(frame))
}

/** A mask with a 4px gap where each chapter after the first begins, or '' with none. */
function cutsOf(chapters: { startTime: number }[], start: number, span: number) {
  if (span <= 0) return ''
  const at = chapters.map((c) => ((c.startTime - start) / span) * 100).filter((p) => p > 0.5 && p < 99.5).sort((a, b) => a - b)
  if (!at.length) return ''
  const stops = at.map((p) => `#000 calc(${p}% - 2px), transparent calc(${p}% - 2px), transparent calc(${p}% + 2px), #000 calc(${p}% + 2px)`)
  return `linear-gradient(to right, #000 0, ${stops.join(', ')}, #000 100%)`
}
