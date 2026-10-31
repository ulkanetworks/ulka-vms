---
paths:
  - "web/src/components/player/**"
  - "web/src/lib/embedBridge.ts"
---
# The player (`components/player`)
Shaka's UI with our skin, one behaviour per file in `skin/`, styles scoped to `.ulka-player`. Shaka's own tooltips,
keys, clicks and context menu are off (`layout.ts`).

## Shaka traps
- Shaka adds classes to the player's box: anything that changes there at runtime (theme, controls) is a `data-`
  attribute. A React `className` wipes `shaka-video-container` and the controls lose their styles.
- Shaka redraws its icons on every state change, so ours on its buttons are CSS masks picked by `aria-label` and
  `aria-pressed`. Engines without ARIA reflection (Firefox < 119) get it from `shaka.ts`.
- Shaka hides pages and the settings card with a forced `display: none`, so animated exits use copies that are then
  removed. It writes the card's `max-height` inline (ours is `!important`), sizes every bar item as a fixed box,
  indents menu labels for a check and forces its speed rows with `!important`: anything new there needs those undone.
- Shaka rounds a pointer on the seek bar to its step (1 s): `skin/preview.ts` sets a fine step only around its mouse
  and touch handlers. Shaka repaints the bar only a few times a second, so the played part is ours
  (`skin/playhead.ts`, every frame).
- Shaka resolves the storyboard's sprite against the storyboard's address: pass it absolute, or no pictures show,
  silently.
- Shaka names wider-than-16:9 qualities by their 16:9 height; `qualityName` renames rows by the short side, as the
  console does. Shaka 5 turns captions off with a null text track.
- Live (`isLive`): `ulka_live` replaces the times, and every seek works within `playable`, never the video's duration.

## Look and size
- Controls are liquid glass pills: `skin/pills.ts` moves Shaka's flat row of items into `.ulka-pill-play`,
  `.ulka-pill-time`, the chapter pill (`ulka_chapter`) and `.ulka-pill-tools` after every build, and Shaka's cast
  button (`remote`) into the top bar (`.ulka-top`: back and `title` left, cast right; `onBack` only when not framed).
  The design's icons are `icons/*.svg`, imported `?raw` in `icons.ts`.
- The glass is CSS only (`--ulka-frost`, `--ulka-liquid`, `--ulka-rim`, `--ulka-r`): a rim box-shadow plus three
  layers at z-index -1 (`::before`, `::after`, `.ulka-ring`). Menus and tooltips stay frosted (`--ulka-glass`).
  Without `backdrop-filter` every surface is plain 80% black (the `@supports not` block at the end of `player.css`).
- The seek bar is painted by us (Shaka's `seekBarColors` transparent): loaded and played in `::before`/`::after`, cut
  at each chapter by a mask (`--ulka-cuts`, `skin/playhead.ts`).
- Phones (Shaka's mobile mode, from the user agent) get Shaka's big play button in our glass (`.ulka-big-icon`). Test
  them with Playwright's `devices['Pixel 7']`, not just `isMobile`.
- Behind the picture is always black, in both themes; the theme colours only the glass. What is drawn on the picture
  uses `--ulka-pic-fg`/`--ulka-pic-shadow`. Clip with `clip-path` as well as `overflow-hidden`: Chrome draws a playing
  video on its own layer, which ignores rounded overflow.
- Each glass surface is the element itself and fades itself, never glass inside a fading element (it loses its blur
  until the fade ends). Write every
  `backdrop-filter` and `mask` with its `-webkit-` twin; give `color-mix()` a plain fallback before it.
- Menus have fixed widths, not fit-to-content (the card jumps while Shaka fills in values). The settings card and its
  page animations are `skin/menu.ts`; the right-click menu and its placement (`place`) are `skin/contextmenu.ts`.
  Times are as wide as their text, as the design has it.
- From 48rem the web design (48px pills, skips, the chapter from 60rem), below it the small one (28px pills, the time
  pill across the top, no skips or back). It must work from a 320×180 embed up: items drop by container width, and every menu is capped to
  the player's height and scrolls, never sideways. Check a new control at 320, 400, 540 and 768 wide.
- Focus rings show only with `ulka-keys` (set by Tab, cleared by any pointer); tooltips are for mouse and pen only.
  Keep the Keyboard shortcuts menu in step with `keys.ts` and the tooltips' keys in `skin/tooltips.ts`. The About menu's build comes from git at build time
  (`__PLAYER_BUILD__`), so builds need a git checkout.

## Embed
- The hosted embed takes docs.ulka.co's address options (`autoplay`, `loop`, `muted`, `controls`, `preload`, `t`) and
  answers its Player SDK over postMessage (`lib/embedBridge.ts`), listening only to its parent window.
- An http parent page makes the iframe insecure, and AES video then can't be decrypted: test from https or the top
  level.
