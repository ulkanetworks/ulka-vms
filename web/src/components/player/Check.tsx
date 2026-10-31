import { useCallback, useEffect, useRef, useState } from 'react'
import { CopyText } from '@/components/CopyText'
import { ChevronDown } from '@/components/icons'
import { Mark } from '@/components/Logo'
import { Meta } from '@/components/Meta'
import { Section } from '@/components/Section'
import { StatusBadge } from '@/components/StatusBadge'
import { Player } from '@/components/player/Player'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { api, type PlayerConfig } from '@/lib/api'
import {
  PLAYS_ON, STEPS, TITLES, browserStep, clockStep, decrypts, deviceFacts, findingSteps, firstVariant, networkProblem, qualities, renditionParts, speed, timed,
  verdict, type CheckInfo, type Step, type StepId, type StepState,
} from '@/lib/check'
import { countryName } from '@/lib/countries'
import { dt } from '@/lib/format'
import { message } from '@/lib/messages'
import { toast } from '@/lib/toast'

const WORDS: Record<StepState, [string, string]> = {
  waiting: ['Waiting', 'neutral'], running: ['Checking', 'neutral'], ok: ['OK', 'success'],
  note: ['Note', 'warning'], problem: ['Problem', 'danger'], skipped: ['Skipped', 'neutral'],
}
const fresh = () => Object.fromEntries(STEPS.map((s) => [s.id, { id: s.id, state: 'waiting' }])) as Record<StepId, Step>
const MS = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'millisecond', maximumFractionDigits: 0 })
const SECONDS = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'second', maximumFractionDigits: 1 })
const SIZE = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 })
const CLOCK = dt(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
const text = (b: ArrayBuffer) => new TextDecoder().decode(b)

/** The viewer check: every step a player takes, run from this browser, with a code to give the website's team. */
export function Check({ lib, video, token, ref }: { lib: string; video: string; token: string; ref: string }) {
  const base = `/${lib}/${video}`
  const [steps, setSteps] = useState(fresh)
  const [device, setDevice] = useState<[string, string][]>([])
  const [config, setConfig] = useState<PlayerConfig | null>(null)
  const [running, setRunning] = useState(false)
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const set = useCallback((s: Step) => setSteps((all) => ({ ...all, [s.id]: s })), [])

  const run = useCallback(async () => {
    const q = () => `?${token ? `token=${token}&` : ''}ref=${encodeURIComponent(ref)}`
    setRunning(true)
    setSteps(fresh())
    setConfig(null)
    setCode('')
    void deviceFacts().then(setDevice)
    const skip = (...ids: StepId[]) => ids.forEach((id) => set({ id, state: 'skipped' }))
    const later: StepId[] = ['playlist', 'key', 'servers', 'data', 'playback']

    set({ id: 'connection', state: 'running' })
    let info: CheckInfo
    try {
      const sent = Date.now()
      const r = await timed(`${base}/check.json${q()}`)
      if (!r.res.ok) throw r.res.status
      info = JSON.parse(text(r.body))
      const country = info.viewer.country ? countryName(info.viewer.country) : ''
      set({ id: 'connection', state: 'ok', ms: r.ms, value: [info.viewer.ip, country].filter(Boolean).join(' · '),
        facts: [['Internet address', info.viewer.ip], ['Country', country || 'Unknown'], ['Our answer took', MS.format(r.ms)]] })
      const server = new Date(info.server_time)
      const skew = server.getTime() - (sent + r.ms / 2)
      set({ id: 'clock', ...clockStep(skew),
        facts: [['Your clock', CLOCK.format(new Date(server.getTime() - skew))], ['Ours', CLOCK.format(server)], ['Difference', SECONDS.format(Math.abs(skew) / 1000)]] })
    } catch (e) {
      const detail = e === 404 ? "This video can't be found. It may have been removed." : networkProblem(typeof e === 'number' ? e : undefined)
      set({ id: 'connection', state: 'problem', detail, facts: [['Answer', typeof e === 'number' ? `HTTP ${e}` : 'No answer']] })
      skip('clock', 'link', 'access', 'video', 'browser', ...later)
      setRunning(false)
      return
    }
    findingSteps(info).forEach(set)
    const canHLS = document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== ''
    const browser = browserStep(window as never, canHLS)
    set({ id: 'browser', ...browser, facts: [['Plays H.264 and AAC', browser.state === 'ok' ? 'Yes' : 'No'], ['Built-in HLS', canHLS ? 'Yes' : 'No']] })
    if (!info.plays || browser.state === 'problem') {
      skip(...later)
      setRunning(false)
      return
    }

    const step = async (id: StepId, fn: () => Promise<Omit<Step, 'id'>>) => {
      set({ id, state: 'running' })
      try {
        set({ id, ...(await fn()) })
      } catch (e) {
        const status = typeof e === 'number' ? e : undefined
        set({ id, state: 'problem', detail: networkProblem(status), cause: e instanceof Error ? e.message : String(e),
          facts: [['Answer', status ? `HTTP ${status}` : "Blocked or didn't arrive"]] })
      }
    }
    const get = async (url: string) => {
      const r = await timed(url)
      if (!r.res.ok) throw r.res.status
      return r
    }
    let parts: ReturnType<typeof renditionParts> | undefined
    let key: ArrayBuffer | undefined
    let piece: ArrayBuffer | undefined
    await step('playlist', async () => {
      const c = await get(`${base}/config.json${q()}`)
      const cfg = JSON.parse(text(c.body)) as PlayerConfig
      setConfig(cfg)
      const masterURL = new URL(`${base}/${cfg.stream}`, location.href).href
      const m = await get(masterURL)
      const variant = firstVariant(text(m.body), masterURL)
      if (!variant) return { state: 'problem', detail: 'The video lists no qualities to play. Let the website know.' }
      const v = await get(variant)
      parts = renditionParts(text(v.body), variant)
      const total = c.ms + m.ms + v.ms
      return { state: 'ok', ms: total, value: MS.format(total),
        facts: [['Qualities', qualities(text(m.body))], ['Player settings', MS.format(c.ms)], ['Video list', MS.format(m.ms)], ['First quality', MS.format(v.ms)]] }
    })
    if (parts?.key) {
      const keyURL = parts.key
      await step('key', async () => {
        const r = await get(keyURL)
        const facts: [string, string][] = [['From', new URL(keyURL).host], ['Took', MS.format(r.ms)]]
        if (r.body.byteLength !== 16) return { state: 'problem', detail: "The unlock key that arrived isn't valid. Let the website know.", cause: `${r.body.byteLength} bytes`, facts }
        key = r.body
        return { state: 'ok', ms: r.ms, value: `${new URL(keyURL).host} · ${MS.format(r.ms)}`, facts }
      })
    } else skip('key')
    if (parts?.segment) {
      const segURL = parts.segment
      await step('servers', async () => {
        const init = parts?.init ? await get(parts.init) : undefined
        const r = await get(segURL)
        piece = r.body
        return { state: 'ok', ms: r.ms, value: `${new URL(segURL).host} · ${speed(r.body.byteLength, r.ms)}`,
          facts: [['From', new URL(segURL).host], ...(init ? [['Start of the video', `${SIZE.format(init.body.byteLength / 1000)} in ${MS.format(init.ms)}`] as [string, string]] : []),
            ['First piece', `${SIZE.format(r.body.byteLength / 1000)} in ${MS.format(r.ms)}`], ['Speed', speed(r.body.byteLength, r.ms)]] }
      })
    } else skip('servers')
    if (key && piece && parts?.iv) {
      const [k, p, iv] = [key, piece, parts.iv]
      await step('data', async () => (await decrypts(p, k, iv))
        ? { state: 'ok', value: 'Intact', facts: [['Protection', 'Basic DRM'], ['Result', 'A whole piece of video']] }
        : { state: 'problem', detail: 'The video arrived damaged. Try another network, then let the website know.', facts: [['Protection', 'Basic DRM'], ['Result', "Didn't unlock into video"]] })
    } else skip('data')
    setSteps((all) => (all.servers.state === 'ok' ? { ...all, playback: { id: 'playback', state: 'running' } } : { ...all, playback: { id: 'playback', state: 'skipped' } }))
    setRunning(false)
  }, [base, token, ref, set])

  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void run()
  }, [run])

  const list = STEPS.map((s) => steps[s.id])
  const busy = running || steps.playback.state === 'running'
  const v = verdict(list)

  async function send() {
    setSending(true)
    try {
      const r = await api<{ code: string }>('POST', `${base}/report`, {
        plays: v.ok,
        results: [...list.map(({ id, state, ms, value, detail, cause, facts }) => ({ id, state, ms, value, detail, cause, facts })), { id: 'device', state: 'ok', facts: device }],
      })
      setCode(r.code)
    } catch (e) {
      toast(message(e), 'danger')
    } finally {
      setSending(false)
    }
  }

  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-4 py-6">
      <Meta title="Playback check" description="Checks each step your browser takes to play this video." />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Mark className="size-9" />
          <div>
            <h1 className="font-semibold text-xl">Playback check</h1>
            <p>Trouble watching a video? This checks each step your browser takes to play it.</p>
          </div>
        </div>
        <Button variant="outline" onClick={() => void run()} disabled={busy}>Check again</Button>
      </header>

      {busy ? (
        <Alert>
          <Spinner />
          <AlertTitle>Checking…</AlertTitle>
          <AlertDescription>This takes a few seconds. Keep this tab open and in front.</AlertDescription>
        </Alert>
      ) : (
        <Alert variant={v.ok ? 'success' : 'error'}>
          <AlertTitle>{v.title}</AlertTitle>
          <AlertDescription>{v.action}</AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Section title="Steps" description="What a player does, in order. Open a step for its measurements." flush>
          <ul className="divide-y">
            {list.map((s) => <StepRow key={s.id} step={s} />)}
          </ul>
        </Section>
        <div className="grid content-start gap-4">
          <Section title="Playback" description="Five seconds of the video, muted, as your player would play it.">
            <div className="aspect-video overflow-hidden rounded-lg bg-black">
              {config && steps.playback.state !== 'skipped' ? (
                <Playback base={base} config={config} onDone={set} />
              ) : (
                <div className="grid size-full place-items-center px-6 text-center text-sm text-white/70">
                  {steps.playback.state === 'skipped' ? 'Skipped: fix the problem above first.' : 'Waiting for the steps before it.'}
                </div>
              )}
            </div>
          </Section>
          <Section
            title="Send the results"
            description="The website's team sees exactly what this browser found. Give them the code; it works for 30 days."
            action={!code && <Button onClick={() => void send()} disabled={busy} loading={sending}>Send</Button>}
          >
            {code ? (
              <div className="grid gap-1">
                <span className="text-sm">Your report code</span>
                <CopyText value={code} what="report code" className="text-lg" />
              </div>
            ) : (
              <p className="text-sm">Includes your internet address, the device details above and each step. Nothing else from your device.</p>
            )}
          </Section>
        </div>
        <div className="grid content-start gap-4">
          <Section title="Your device" description="What this browser tells any website it visits.">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              {device.map(([k, val]) => (
                <div key={k} className="contents">
                  <dt>{k}</dt>
                  <dd className="min-w-0 truncate">{val}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <Section title="Where this video plays" description="This video is protected with Basic DRM, which every common device can play.">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              {PLAYS_ON.map(([k, val]) => (
                <div key={k} className="contents">
                  <dt>{k}</dt>
                  <dd className="min-w-0">{val}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </div>
      </div>
    </main>
  )
}

function StepRow({ step: s }: { step: Step }) {
  const [word, tone] = WORDS[s.state]
  const head = (
    <>
      <div className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-medium">{TITLES[s.id]}</span>
          {s.value && <span className="truncate font-mono text-xs">{s.value}</span>}
        </div>
        {s.detail && <p className="mt-0.5 text-sm">{s.detail}</p>}
      </div>
      <StatusBadge tone={tone} busy={s.state === 'running'}>{word}</StatusBadge>
    </>
  )
  if (!s.facts?.length) return <li className="flex items-start gap-3 px-5 py-2">{head}<span aria-hidden="true" className="size-4 shrink-0" /></li>
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-start gap-3 px-5 py-2 hover:bg-accent/50">
          {head}
          <ChevronDown className="mt-0.5 size-4 shrink-0 transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 px-5 pb-3 text-sm">
            {s.facts.map(([k, val]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd className="min-w-0 truncate font-mono text-xs leading-5">{val}</dd>
              </div>
            ))}
          </dl>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  )
}

/** Plays the video muted and says when it started and whether it kept going for five seconds. A hidden tab or a
 *  pause stops the browser playing, so those are told apart from a slow connection. */
function Playback({ base, config, onDone }: { base: string; config: PlayerConfig; onDone: (s: Step) => void }) {
  const [el, setEl] = useState<HTMLVideoElement | null>(null)
  useEffect(() => {
    if (!el) return
    const start = performance.now()
    let started = 0
    let stalls = 0
    let hidden = document.hidden
    let paused = false
    let done = false
    const facts = (): [string, string][] => {
      const q = el.getVideoPlaybackQuality?.()
      const ahead = el.buffered.length ? el.buffered.end(el.buffered.length - 1) - el.currentTime : 0
      return [
        ['Started after', started ? MS.format(started) : 'Not started'],
        ['Playing at', el.videoHeight ? `${el.videoHeight}p` : '—'],
        ['Pauses to load', String(stalls)],
        ['Dropped frames', q ? `${q.droppedVideoFrames} of ${q.totalVideoFrames}` : '—'],
        ['Loaded ahead', SECONDS.format(Math.max(0, ahead))],
      ]
    }
    const finish = (s: Omit<Step, 'id' | 'facts'>) => {
      if (done) return
      done = true
      onDone({ id: 'playback', ...s, facts: facts() })
    }
    const ok = () => finish(stalls > 1
      ? { state: 'note', ms: Math.round(started), value: `${stalls} pauses`, detail: 'It plays, but pauses to load on this connection. A faster network helps.' }
      : { state: 'ok', ms: Math.round(started), value: `Started in ${MS.format(started)}` })
    const onPlaying = () => { if (!started) started = performance.now() - start }
    const onWaiting = () => { if (started) stalls++ }
    const onTime = () => { if (el.currentTime >= 5) ok() }
    const onPause = () => { if (!el.ended && started) paused = true }
    const onVisible = () => { if (document.hidden) hidden = true }
    const onError = () => finish({ state: 'problem', detail: "The video didn't play in this browser. Let the website know, with the code below." })
    const limit = setTimeout(() => {
      if (el.ended || el.currentTime >= 5) return ok()
      if (hidden) return finish({ state: 'note', detail: 'This tab was in the background, so the browser paused the test. Keep it in front and check again.' })
      if (paused) return finish({ state: 'note', detail: 'The video was paused before the test finished. Check again and let it play.' })
      finish(started
        ? { state: 'problem', detail: 'The video started, then stopped loading. Try another network.' }
        : { state: 'problem', detail: "The video didn't start within 25 seconds. Try another network." })
    }, 25_000)
    el.addEventListener('playing', onPlaying)
    el.addEventListener('waiting', onWaiting)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('ended', ok)
    el.addEventListener('pause', onPause)
    el.addEventListener('error', onError)
    document.addEventListener('visibilitychange', onVisible)
    void el.play().catch(() => {})
    return () => {
      clearTimeout(limit)
      el.removeEventListener('playing', onPlaying)
      el.removeEventListener('waiting', onWaiting)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('ended', ok)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('error', onError)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [el, onDone])
  return (
    <Player
      settings={{ ...config.settings, autoplay: true, muted: true }}
      src={`${base}/${config.stream}`}
      poster={`${base}/${config.poster}`}
      preload="auto"
      onVideo={setEl}
      fill
    />
  )
}
