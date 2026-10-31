// The hosted player answers its parent page over postMessage in docs.ulka.co's Player SDK format (@vidinfra/player):
// commands {type: "command", id?, action, data}, answers {type: "response", id, data | error}, events {type: "event"}.

const EVENTS = ['play', 'playing', 'pause', 'ended', 'timeupdate', 'volumechange', 'seeking', 'seeked', 'waiting', 'canplay',
  'canplaythrough', 'loadedmetadata', 'loadeddata', 'durationchange', 'ratechange', 'error'] as const

type Command = { type: 'command'; id?: string; action: string; data?: Record<string, unknown> }

const state = (v: HTMLVideoElement) => ({ currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : 0, paused: v.paused,
  muted: v.muted, volume: v.volume, playbackRate: v.playbackRate, ended: v.ended })

/** Starts the bridge for video; setControls shows or hides the player's controls. Returns the cleanup. */
export function bridge(video: HTMLVideoElement, setControls: (on: boolean) => void): () => void {
  const parent = window.parent
  if (parent === window) return () => {}
  const send = (msg: Record<string, unknown>) => parent.postMessage(msg, '*')
  const emit = (event: string) => send({ type: 'event', event, data: state(video) })

  const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN)
  const actions: Record<string, (d: Record<string, unknown>) => unknown> = {
    play: () => video.play(),
    pause: () => video.pause(),
    togglePlay: () => (video.paused ? video.play() : video.pause()),
    seek: (d) => { if (num(d.time) >= 0) video.currentTime = num(d.time) },
    setVolume: (d) => { if (num(d.volume) >= 0 && num(d.volume) <= 1) video.volume = num(d.volume) },
    getVolume: () => video.volume,
    mute: () => { video.muted = true },
    unmute: () => { video.muted = false },
    setMuted: (d) => { video.muted = d.muted === true },
    getMuted: () => video.muted,
    getCurrentTime: () => video.currentTime,
    getDuration: () => (Number.isFinite(video.duration) ? video.duration : 0),
    getPaused: () => video.paused,
    toggleFullscreen: full,
    requestFullscreen: () => document.documentElement.requestFullscreen(),
    exitFullscreen: () => document.fullscreenElement && document.exitFullscreen(),
    setPlaybackRate: (d) => { if (num(d.rate) > 0 && num(d.rate) <= 4) video.playbackRate = num(d.rate) },
    getPlaybackRate: () => video.playbackRate,
    showControls: () => setControls(true),
    hideControls: () => setControls(false),
    setControlsVisible: (d) => setControls(d.visible === true),
  }

  const onMessage = async (e: MessageEvent) => {
    if (e.source !== parent) return
    const m = e.data as Command
    if (!m || m.type !== 'command' || typeof m.action !== 'string') return
    const run = Object.hasOwn(actions, m.action) ? actions[m.action] : undefined
    try {
      if (!run) throw new Error(`Unknown command: ${m.action}`)
      const data = await run(m.data ?? {})
      if (m.id) send({ type: 'response', id: m.id, data })
    } catch (err) {
      if (m.id) send({ type: 'response', id: m.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const listeners = EVENTS.map((name) => [name, () => emit(name)] as const)
  for (const [name, fn] of listeners) video.addEventListener(name, fn)
  const onFull = () => emit('fullscreenchange')
  document.addEventListener('fullscreenchange', onFull)
  window.addEventListener('message', onMessage)
  emit('ready')
  return () => {
    for (const [name, fn] of listeners) video.removeEventListener(name, fn)
    document.removeEventListener('fullscreenchange', onFull)
    window.removeEventListener('message', onMessage)
  }
}
