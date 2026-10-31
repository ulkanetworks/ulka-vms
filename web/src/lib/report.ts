// A page that broke tells the API, which logs it for Health → Logs; the person quotes the reference it returns.
const sent = new WeakMap<object, string>()

export function report(error: unknown): string {
  const key = typeof error === 'object' && error !== null ? error : { error }
  const known = sent.get(key)
  if (known) return known // a render can run twice for one crash
  const ref = crypto.randomUUID().slice(0, 8)
  sent.set(key, ref)
  const e = error instanceof Error ? error : new Error(String(error))
  console.error(`page crashed (${ref})`, error)
  fetch('/v1/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, message: e.message, stack: e.stack ?? '', path: location.pathname, build: __PLAYER_BUILD__ }),
    keepalive: true,
  }).catch((err) => console.error('the crash report could not be sent', err))
  return ref
}
