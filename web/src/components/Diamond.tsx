import type { ComponentProps } from 'react'

// From loading-ui.com's "diamond": eight pixels round a diamond, fading in turn. Keyframes are `ulka-diamond` in index.css.
const PIXELS = [[8, 0], [12, 4], [16, 8], [12, 12], [8, 16], [4, 12], [0, 8], [4, 4]]

/** A loading mark in `currentColor`; size it with `size-*`. */
export function Diamond(props: ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" role="status" aria-label="Loading" {...props}>
      {PIXELS.map(([x, y], i) => (
        <rect key={i} className="ulka-diamond" style={{ animationDelay: `${i / 10}s` }} x={x} y={y} width="4" height="4" />
      ))}
    </svg>
  )
}
