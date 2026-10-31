// The player's behaviour on Shaka's controls, one module per job.
import { maskOf, type IconName } from '../icons'
import { actions } from './actions'
import { contextMenu } from './contextmenu'
import { makeCtx, type Controls } from './context'
import { gestures } from './gestures'
import { keys } from './keys'
import { menu } from './menu'
import { pills } from './pills'
import { playhead } from './playhead'
import { preview } from './preview'
import { tooltips } from './tooltips'

export { RATES } from './actions'

/** Adds the behaviour to a built Shaka overlay; returns the cleanup. */
export function attachSkin(box: HTMLElement, controls: Controls, step: () => number, icons: Record<string, string>) {
  const { ctx, detach } = makeCtx(box, controls, step, icons)
  pills(ctx)
  box.tabIndex = 0
  // Shaka's buttons redraw their own icons on every change of state, so ours are masks the CSS picks by state.
  for (const name of ['play', 'pause', 'volume', 'volumeOff', 'settings', 'pictureInPicture', 'fullscreen', 'cast', 'check', 'chevronLeft', 'chevronRight', 'quality', 'subtitle', 'speed', 'chapters', 'info', 'keyboard', 'loop', 'help'] satisfies IconName[]) box.style.setProperty(`--ulka-i-${name}`, maskOf(name))
  const hideTip = tooltips(ctx)
  const a = actions(ctx)
  keys(ctx, a)
  gestures(ctx, a)
  preview(ctx)
  playhead(ctx)
  menu(ctx, hideTip)
  contextMenu(ctx)
  return detach
}
