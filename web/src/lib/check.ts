// The viewer check on the player host (/check/{library}/{video}): each step a player takes, run in the viewer's own
// browser, worded for the viewer. The report sent to the workspace keeps the API's own words beside them.

export type StepId = 'connection' | 'clock' | 'link' | 'access' | 'video' | 'browser' | 'playlist' | 'key' | 'servers' | 'data' | 'playback'
export type StepState = 'waiting' | 'running' | 'ok' | 'note' | 'problem' | 'skipped'

export type Step = {
  id: StepId
  state: StepState
  /** How long it took. */
  ms?: number
  /** A short fact shown at the right: an address, a speed. */
  value?: string
  /** What it means for the viewer, in their words. */
  detail?: string
  /** The server's own explanation, for the workspace reading the report. */
  cause?: string
  /** The measurements behind it, shown when the row is opened and kept in the report. */
  facts?: [string, string][]
}

export const STEPS: { id: StepId; title: string }[] = [
  { id: 'connection', title: 'Your connection' },
  { id: 'clock', title: 'Device clock' },
  { id: 'link', title: 'Video link' },
  { id: 'access', title: 'Where you can watch' },
  { id: 'video', title: 'Video' },
  { id: 'browser', title: 'Browser' },
  { id: 'playlist', title: 'Video details' },
  { id: 'key', title: 'Unlock key' },
  { id: 'servers', title: 'Video servers' },
  { id: 'data', title: 'Video data' },
  { id: 'playback', title: 'Playback' },
]

export const TITLES = Object.fromEntries(STEPS.map((s) => [s.id, s.title])) as Record<StepId, string>

export type Finding = { kind: string; state: 'ok' | 'problem' | 'note'; message: string }

export type CheckInfo = {
  server_time: string
  viewer: { ip: string; country: string }
  status: string
  findings: Finding[]
  plays: boolean
}

/** The clock step: signed links carry an expiry, so a device clock far off makes a valid link look expired. */
const MINUTES = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'minute', unitDisplay: 'long' })
const MBYTES = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'megabyte-per-second', maximumFractionDigits: 1 })
const MBITS = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'megabit-per-second', maximumFractionDigits: 1 })

export function clockStep(skewMs: number): Pick<Step, 'state' | 'value' | 'detail'> {
  const mins = Math.round(Math.abs(skewMs) / 60_000)
  const off = MINUTES.format(mins)
  if (mins >= 5) return { state: 'problem', value: `${off} ${skewMs > 0 ? 'behind' : 'ahead'}`, detail: `Your device's clock is ${off} ${skewMs > 0 ? 'behind' : 'ahead'}. Set it to update automatically, then reload the video.` }
  if (Math.abs(skewMs) >= 30_000) return { state: 'note', value: `${off} off`, detail: 'Your clock is a little off. It should still play.' }
  return { state: 'ok', value: 'Correct' }
}

const worst = (fs: Finding[]) => fs.find((f) => f.state === 'problem') ?? fs.find((f) => f.state === 'note') ?? fs[0]

/** Turns the server's findings about the address into the link, access and video steps. */
export function findingSteps(info: CheckInfo): Step[] {
  const of = (...kinds: string[]) => {
    const want = new Set(kinds)
    return info.findings.filter((f) => want.has(f.kind))
  }
  const step = (id: StepId, fs: Finding[], words: (f: Finding) => string, okValue: string): Step => {
    const f = worst(fs)
    if (!f || f.state === 'ok') return { id, state: 'ok', value: okValue, cause: f?.message }
    return { id, state: f.state, detail: words(f), cause: f.message }
  }
  const link = step('link', of('signature', 'expiry', 'ip'), (f) =>
    f.kind === 'expiry' ? 'This video link has expired. Reload the page you were watching on to get a fresh one.'
      : f.state === 'note' ? 'This link works only from one internet address. Switching networks (Wi-Fi to mobile, a VPN) stops it.'
        : "This link isn't valid for this video. Open the video again from the website you were watching on.", 'Valid')
  const access = step('access', of('page', 'country'), (f) =>
    f.kind === 'country' ? (f.state === 'problem' ? "This video isn't available in your country." : 'The video is limited to some countries.')
      : f.state === 'problem' ? "The website you came from isn't allowed to show this video." : 'Only some websites may show this video.', 'Allowed')
  const video = step('video', of('video'), () =>
    info.status === 'errored' ? "This video couldn't be prepared. Let the website know."
      : info.status === 'ready' || info.status === 'complete' ? 'This video was removed.'
        : 'This video is still being prepared. Try again in a few minutes.', 'Ready')
  return [link, access, video]
}

/** The browser step: Media Source (or Apple's managed one) and the codecs Ulka encodes, or native HLS. */
type MediaSupport = { isTypeSupported(type: string): boolean }

export function browserStep(w: { MediaSource?: MediaSupport; ManagedMediaSource?: MediaSupport }, canPlayHLS: boolean): Pick<Step, 'state' | 'value' | 'detail'> {
  const ms = w.ManagedMediaSource ?? w.MediaSource
  const h264 = !!ms?.isTypeSupported('video/mp4; codecs="avc1.640028"')
  const aac = !!ms?.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')
  if ((h264 && aac) || canPlayHLS) return { state: 'ok', value: 'Supported' }
  return { state: 'problem', detail: "This browser can't play this video. Try an up-to-date Chrome, Safari, Firefox or Edge." }
}

/** The first quality a master playlist lists, as an address. */
export function firstVariant(master: string, base: string): string | null {
  const line = master.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && l.split('?')[0].endsWith('.m3u8'))
  return line ? new URL(line, base).href : null
}

/** What a quality's playlist points at: its key and IV, its start (init) and its first piece. */
export function renditionParts(text: string, base: string) {
  const attr = (tag: string, name: string) => text.match(new RegExp(`#${tag}:[^\\n]*${name}=(?:"([^"]*)"|([^,\\n]*))`))
  const key = attr('EXT-X-KEY', 'URI')
  const iv = attr('EXT-X-KEY', 'IV')
  const init = attr('EXT-X-MAP', 'URI')
  const segment = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  const ivHex = (iv?.[1] ?? iv?.[2] ?? '').replace(/^0x/i, '')
  return {
    key: key ? new URL(key[1] ?? key[2], base).href : undefined,
    iv: /^[0-9a-f]{32}$/i.test(ivHex) ? Uint8Array.from(ivHex.match(/../g)!, (h) => parseInt(h, 16)) : undefined,
    init: init ? new URL(init[1] ?? init[2], base).href : undefined,
    segment: segment ? new URL(segment, base).href : undefined,
  }
}

const NETWORK = "Your connection couldn't reach this part of the video service. Try another network, or turn off a VPN or ad blocker."

/** Words for a network step that failed: refused (status) or never answered (blocked, offline, CORS). */
export function networkProblem(status?: number): string {
  if (status === 403) return "The video service refused this request. Reload the page you were watching on, then try again."
  if (status && status >= 500) return 'The video service had a problem. Try again in a minute.'
  return NETWORK
}

/** The page's headline: the first problem, or all clear. */
export function verdict(steps: Step[]): { ok: boolean; title: string; action: string } {
  const p = steps.find((s) => s.state === 'problem')
  if (!p) return { ok: true, title: 'All good. The video should play.', action: 'Still stuck? Reload the page you were watching on.' }
  return { ok: false, title: `${TITLES[p.id]}: something is wrong`, action: p.detail ?? NETWORK }
}

/** A speed in megabytes a second, worded by Intl. */
export function speed(bytes: number, ms: number): string {
  return MBYTES.format(bytes / 1e6 / Math.max(ms / 1000, 0.001))
}

/** fetch with a time limit; answers how long it took, or the HTTP status that refused it. */
export async function timed(url: string, init?: RequestInit, limitMs = 15_000) {
  const start = performance.now()
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(limitMs) })
  const body = await res.arrayBuffer()
  return { res, body, ms: Math.round(performance.now() - start) }
}

/** Decrypts an AES-128 full-segment piece the way a player does, and says whether a fragment header is inside. */
export async function decrypts(piece: ArrayBuffer, key: ArrayBuffer, iv: Uint8Array): Promise<boolean> {
  const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt'])
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, piece))
  const head = new TextDecoder('latin1').decode(clear.subarray(0, 2048))
  return head.includes('moof') || head.includes('styp')
}

type UAData = { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean }
type Net = { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean }

/** The browser and system, from the User-Agent Client Hints where there are any, else the user agent. */
export function browserName(ua: string, data?: UAData): string {
  const brand = data?.brands?.find((b) => !/not.?a.?brand|chromium/i.test(b.brand))
  if (brand) return `${brand.brand} ${brand.version}`
  // Most specific first: Edge and Opera also say Chrome, and every iOS browser says Safari.
  for (const [token, name] of [['Edg', 'Edge'], ['OPR', 'Opera'], ['CriOS', 'Chrome'], ['FxiOS', 'Firefox'], ['Firefox', 'Firefox'], ['Chrome', 'Chrome']]) {
    const m = ua.match(new RegExp(`${token}/(\\d+)`))
    if (m) return `${name} ${m[1]}`
  }
  const safari = ua.match(/Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/)
  return safari ? `Safari ${safari[1]}` : 'Unknown'
}

export function systemName(ua: string, data?: UAData): string {
  if (data?.platform) return data.platform
  for (const [re, name] of [[/iPhone|iPad|iPod/, 'iOS'], [/Android/, 'Android'], [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'macOS'], [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux']] as const) {
    if (re.test(ua)) return name
  }
  return 'Unknown'
}

/** Where a Basic DRM video plays: anything that plays HLS video, in the browser or an app. */
export const PLAYS_ON: [string, string][] = [
  ['Browsers', 'Chrome, Safari, Edge, Firefox, Opera, Brave, Samsung Internet'],
  ['Computers', 'Windows, Mac, Linux, Chromebook'],
  ['Phones and tablets', 'iPhone, iPad, Android'],
  ['TVs', 'Apple TV, Android TV and Google TV, Fire TV, Roku, Chromecast, Samsung and LG smart TVs'],
]

const KEY_SYSTEMS: [string, string][] = [['Widevine', 'com.widevine.alpha'], ['PlayReady', 'com.microsoft.playready'], ['FairPlay', 'com.apple.fps'], ['ClearKey', 'org.w3.clearkey']]

/** Which DRM systems this browser offers (what protected videos need). */
export async function drmSystems(): Promise<string[]> {
  if (!navigator.requestMediaKeySystemAccess) return []
  const config: MediaKeySystemConfiguration[] = [{ initDataTypes: ['cenc', 'sinf', 'skd'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]
  const found = await Promise.all(KEY_SYSTEMS.map(([name, id]) => navigator.requestMediaKeySystemAccess(id, config).then(() => name, () => '')))
  return found.filter(Boolean)
}

/** This device as the report shows it: nothing beyond what any website can read. */
export async function deviceFacts(): Promise<[string, string][]> {
  const data = (navigator as { userAgentData?: UAData }).userAgentData
  const net = (navigator as { connection?: Net }).connection
  const drm = await drmSystems().catch(() => [])
  const facts: [string, string][] = [
    ['Browser', browserName(navigator.userAgent, data)],
    ['System', `${systemName(navigator.userAgent, data)}${data?.mobile ? ' (phone or tablet)' : ''}`],
    ['Screen', `${screen.width} × ${screen.height}, ${devicePixelRatio}× pixels`],
    ['Language', navigator.language],
    ['Time zone', Intl.DateTimeFormat().resolvedOptions().timeZone],
    ['Browser DRM support', drm.length ? drm.join(', ') : 'None'],
  ]
  if (net?.effectiveType) {
    const parts = [net.effectiveType.toUpperCase()]
    if (net.downlink) parts.push(MBITS.format(net.downlink))
    if (net.rtt) parts.push(`${net.rtt} ms round trip`)
    if (net.saveData) parts.push('data saver on')
    facts.push(['Network', parts.join(' · ')])
  }
  return facts
}

/** The qualities a master playlist offers, by height: "1080p, 720p, 360p". */
export function qualities(master: string): string {
  const heights = [...master.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]))
  return [...new Set(heights)].sort((a, b) => b - a).map((h) => `${h}p`).join(', ') || 'Not listed'
}
