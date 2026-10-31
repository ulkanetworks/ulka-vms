import type { Chapter, PlayerSettings } from '@/lib/api'
import { RATES } from './skin'

/** Shaka's UI configuration: which items the bar holds, in order, and what the settings menu offers. */
export function layout(s: PlayerSettings, chapters = false) {
  const line = s.theme === 'light' ? '0,0,0' : '255,255,255'
  const overflow = [s.quality && 'quality', 'language', s.speed && 'playback_rate', s.captions && 'captions', chapters && 'chapter'].filter(Boolean) as string[]
  return {
    controlPanelElements: [
      'play_pause',
      ...(s.skip ? ['ulka_back', 'ulka_forward'] : []),
      'mute_volume',
      'ulka_chapter',
      'ulka_live',
      'ulka_current',
      'ulka_remaining',
      ...(s.captions ? ['ulka_captions'] : []),
      // The browser's own casting (Remote Playback: Chromecast in Chrome, AirPlay in Safari); hidden while no device is found.
      'remote',
      'overflow_menu',
      ...(s.pip ? ['picture_in_picture'] : []),
      ...(s.fullscreen ? ['fullscreen'] : []),
      'ulka_brand',
    ],
    overflowMenuButtons: overflow,
    playbackRates: RATES,
    // Tooltips, keys, clicks and the right-click menu are ours (skin/), so Shaka's are off.
    customContextMenu: false,
    // Phones turn to landscape in fullscreen; iPhones use the video's own fullscreen (Shaka handles both).
    forceLandscapeOnFullscreen: true,
    enableTooltips: false,
    enableKeyboardPlaybackControls: false,
    singleClickForPlayAndPause: false,
    doubleClickForFullscreen: false,
    // The track, what has loaded and what has played are ours (player.css, skin/playhead.ts), cut at each chapter;
    // Shaka paints none of them.
    seekBarColors: { base: 'transparent', buffered: 'transparent', played: 'transparent', chapters: 'transparent' },
    // The level in the played part's colour (the design's 80% white, or black in the light theme).
    volumeBarColors: { base: `rgba(${line},.2)`, level: `rgba(${line},.8)` },
  }
}

/** The settings menu's row names. */
export const LABELS = new Map([['RESOLUTION', 'Quality'], ['LANGUAGE', 'Audio'], ['PLAYBACK_RATE', 'Playback Speed'], ['CAPTIONS', 'Subtitle']])

// Chapters as a WebVTT chapters track, which Shaka shows on the seek bar and in its Chapters menu.
const two = (n: number) => String(n).padStart(2, '0')
const vttTime = (t: number) => `${two(Math.floor(t / 3600))}:${two(Math.floor(t / 60) % 60)}:${two(t % 60)}.000`
export const chaptersVTT = (cs: Chapter[]) => 'WEBVTT\n\n' + cs.map((c) => `${vttTime(c.start_time)} --> ${vttTime(c.end_time)}\n${c.title.replace(/\n|-->/g, ' ')}\n`).join('\n')
