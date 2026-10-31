// The player's icons: the Ulka player design's (icons/, from Figma), the rest from ulka-player-sdk (src/icons.ts),
// and info, keyboard and loop from Lucide (the console's set).
import arrowLeft from './icons/arrow-left.svg?raw'
import brand from './icons/brand.svg?raw'
import cast from './icons/cast.svg?raw'
import chapters from './icons/chapters.svg?raw'
import chevron from './icons/chevron.svg?raw'
import fullscreen from './icons/fullscreen.svg?raw'
import pause from './icons/pause.svg?raw'
import volumeHigh from './icons/volume-high.svg?raw'
import volumeLow from './icons/volume-low.svg?raw'
import volumeMuted from './icons/volume-muted.svg?raw'
import volumeNone from './icons/volume-none.svg?raw'
import menuBack from './icons/menu-back.svg?raw'
import menuCheck from './icons/menu-check.svg?raw'
import menuNext from './icons/menu-chevron-right.svg?raw'
import menuQuality from './icons/menu-quality.svg?raw'
import menuSpeed from './icons/menu-speed.svg?raw'
import menuSubtitle from './icons/menu-subtitle.svg?raw'
import pip from './icons/pip.svg?raw'
import play from './icons/play.svg?raw'
import settings from './icons/settings.svg?raw'
import skipBack10 from './icons/skip-back-10.svg?raw'
import skipForward10 from './icons/skip-forward-10.svg?raw'
import volume from './icons/volume.svg?raw'

/** A design icon in the controls' colour: its white fill becomes currentColor (a mask reads only its shape). */
const design = (svg: string) => svg.replace(/fill="white"/g, 'fill="currentColor"').replace('<svg ', '<svg aria-hidden="true" ')

export const ICONS = {
  arrowLeft: design(arrowLeft),
  brand: design(brand),
  cast: design(cast),
  chapter: design(chevron),
  play: design(play),
  pause: design(pause),
  volume: design(volume),
  volumeOff: design(volumeMuted),
  volumeNone: design(volumeNone),
  volumeLow: design(volumeLow),
  volumeHigh: design(volumeHigh),
  chapters: design(chapters),
  pictureInPicture: design(pip),
  fullscreen: design(fullscreen),
  settings: design(settings),
  check: design(menuCheck),
  chevronLeft: design(menuBack),
  chevronRight: design(menuNext),
  quality: design(menuQuality),
  subtitle: design(menuSubtitle),
  speed: design(menuSpeed),
  seekBackward: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" fill="none" aria-hidden="true"> <path d="M28 13.5L18.5 22L28 30.5V13.5Z" fill="currentColor"/> <path d="M36 13.5L26.5 22L36 30.5V13.5Z" fill="currentColor" fill-opacity="0.6"/> </svg>',
  seekForward: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" fill="none" aria-hidden="true"> <path d="M16 13.5L25.5 22L16 30.5V13.5Z" fill="currentColor"/> <path d="M8 13.5L17.5 22L8 30.5V13.5Z" fill="currentColor" fill-opacity="0.6"/> </svg>',
  seekBackward10: design(skipBack10),
  seekForward10: design(skipForward10),
  info: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  keyboard: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/></svg>',
  help: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  loop: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
} as const

export type IconName = keyof typeof ICONS

/** An icon as a CSS mask image, for Shaka's buttons, which redraw their own icon on every change of state. */
export const maskOf = (name: IconName) => `url("data:image/svg+xml,${encodeURIComponent(ICONS[name].replace(/currentColor/g, '#000'))}")`
