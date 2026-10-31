const two = (n: number) => String(n).padStart(2, '0')

/** m:ss, or h:mm:ss once the video runs an hour. */
export function clock(t: number, duration: number) {
  const s = Math.floor(Math.abs(t))
  const [h, m] = [Math.floor(s / 3600), Math.floor(s / 60) % 60]
  return h || duration >= 3600 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}
