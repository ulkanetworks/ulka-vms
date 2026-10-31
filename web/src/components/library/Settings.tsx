import { CountryPicker } from '@/components/CountryPicker'
import { useState } from 'react'
import { LoadError } from '@/components/LoadError'
import { createPortal } from 'react-dom'
import * as v from 'valibot'
import { Video } from '@/components/icons'
import { Code } from '@/components/Code'
import { Player, defaultPlayer } from '@/components/player/Player'
import { Pick as Choose } from '@/components/Pick'
import { TagInput } from '@/components/TagInput'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Section } from '@/components/Section'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Lock, useInherit } from '@/components/library/Inherit'
import { embedOf } from '@/components/library/Privacy'
import { usePreview } from '@/lib/preview'
import { type Asset, type Library, type PlayerSettings, type PlayerTemplate, type Policy, type VideoDefaults } from '@/lib/api'
import { useGet } from '@/lib/query'
import { problemsOf, validHostname } from '@/lib/schemas'
import { save } from '@/lib/save'
import { rules } from '@/lib/rules'
import { SaveBar } from '@/components/SaveBar'

const SKIPS = [{ label: 'Hidden', value: '0' }, ...[5, 10, 15, 30].map((n) => ({ label: `${n} seconds`, value: String(n) }))]
const DEFAULTS = '/v1/video/defaults'
const NOTE = 'Saved. It applies to every library that follows the workspace defaults.'

const hex = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #10b981.'))
const https = (what: string) =>
  v.pipe(v.string(), v.trim(), v.check((s) => s === '' || (s.length <= rules.limits.url && v.is(v.pipe(v.string(), v.url()), s) && s.startsWith('https://')), `${what} must start with https://.`))
const playerSchema = v.object({ accent: hex, logo_url: https('The logo address'), logo_link: https('The logo link') })

// The player's on/off settings, by tab: how it starts and what controls it shows.
const PLAYBACK: [keyof PlayerSettings, string, string][] = [
  ['autoplay', 'Start playing by itself', 'Browsers only allow this with the sound off, so it plays muted.'],
  ['loop', 'Play again when it ends', ''],
  ['muted', 'Start with the sound off', ''],
]
const CONTROLS: [keyof PlayerSettings, string, string][] = [
  ['controls', 'Show controls', 'Off hides every button, for a moving background or a page that controls the player itself.'],
  ['speed', 'Speed control', 'Lets viewers watch faster or slower.'],
  ['quality', 'Quality menu', 'Lets viewers pick a picture quality.'],
  ['captions', 'Captions menu', 'Lets viewers turn subtitles on.'],
  ['pip', 'Picture in picture', 'Lets viewers keep the video in a small window while they do other things.'],
  ['fullscreen', 'Full screen button', ''],
]

function Switches({ rows, draft, set }: { rows: typeof PLAYBACK; draft: PlayerSettings; set: (p: Partial<PlayerSettings>) => void }) {
  return (
    <>
      {rows.map(([key, label, hint]) => (
        <Field key={key} className="flex-row items-start gap-3">
          <div className="flex flex-1 flex-col gap-1">
            <FieldLabel htmlFor={`p-${key}`}>{label}</FieldLabel>
            {hint && <FieldDescription>{hint}</FieldDescription>}
          </div>
          <Switch id={`p-${key}`} checked={draft[key] as boolean} onCheckedChange={(c) => set({ [key]: c })} />
        </Field>
      ))}
    </>
  )
}

/** actions: where the page wants Save and Reset (its header); without one they sit above the preview. */
export function PlayerTab({ lib, actions }: { lib?: Library; actions?: HTMLElement | null }) {
  const own = useGet<PlayerSettings>(lib ? `/v1/libraries/${lib.id}/player` : null)
  const defaults = useGet<VideoDefaults>(lib ? null : DEFAULTS)
  const { locked, bar } = useInherit(lib, 'player')
  const q = lib ? own : defaults
  const saved = lib ? own.data : defaults.data?.player
  if (q.error) return <LoadError error={q.error} retry={q.refetch} />
  if (!saved) return <Skeleton className="h-96 w-full" />
  return (
    <>
      {bar}
      <PlayerEditor key={JSON.stringify(saved)} lib={lib} saved={saved} locked={locked} actions={actions} />
    </>
  )
}

function PlayerEditor({ lib, saved, locked, actions }: { lib?: Library; saved: PlayerSettings; locked: boolean; actions?: HTMLElement | null }) {
  const [draft, setDraft] = useState<PlayerSettings>(saved)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set = (p: Partial<PlayerSettings>) => setDraft((d) => ({ ...d, ...p }))
  const templates = useGet<{ data: PlayerTemplate[] }>('/v1/player/templates').data?.data ?? []
  // The template the switches below match now, if any; changing a switch makes it your own mix.
  const current = templates.find((t) => Object.entries(t.settings).every(([k, v]) => draft[k as keyof PlayerSettings] === v))?.key ?? ''
  const videos = useGet<{ data: Asset[] }>(`/v1/assets?${lib ? `library_id=${lib.id}&` : ''}limit=25`)
  // A public video previews at its own address; a private one needs a signing key, so it comes second.
  const ready = videos.data?.data.filter((a) => a.status === 'ready' || a.status === 'complete') ?? []
  const pick = ready.find((a) => a.playback_policy === 'public') ?? ready[0]
  const { preview, problem } = usePreview(pick)
  const changed = JSON.stringify(draft) !== JSON.stringify(saved)

  async function submit() {
    const parsed = v.safeParse(playerSchema, draft)
    setProblems(parsed.success ? {} : problemsOf(parsed.issues))
    if (!parsed.success) return
    setBusy(true)
    const body = { ...draft, ...parsed.output }
    const out = lib
      ? await save<PlayerSettings>(`/v1/libraries/${lib.id}/player`, 'PUT', body, 'Player saved. It applies to every video in this library.')
      : (await save<VideoDefaults>(DEFAULTS, 'PUT', { player: body }, NOTE))?.player
    if (out) setDraft(out)
    setBusy(false)
  }
  const buttons = (
    <>
      <SaveBar dirty={changed && !locked} saving={busy} onSave={() => void submit()} onDiscard={() => (setProblems({}), setDraft(saved))} />
      <Button size="sm" variant="outline" onClick={() => setDraft(defaultPlayer)} disabled={busy || locked}>
        Reset
      </Button>
    </>
  )
  const snippet = pick ? embedOf(pick) : embedOf({ id: '', playback_policy: 'public', embed_url: 'PLAYER_ADDRESS/LIBRARY_ID/VIDEO_ID' })

  return (
    <div className="grid gap-6">
      {actions ? createPortal(buttons, actions) : <div className="flex justify-end gap-2">{buttons}</div>}
      {/* Wide screens: settings on the left, the preview pinned on the right so each change shows while scrolling.
          Narrow ones: the preview above the settings (pinned, it would cover them). */}
      <div className="grid w-full max-w-3xl items-start gap-6 xl:max-w-none xl:grid-cols-2">
        <div className="xl:sticky xl:top-4 xl:order-2">
        {preview ? (
          <Player settings={draft} {...preview} />
        ) : videos.isPending || (pick && !problem) ? (
          <Skeleton className="aspect-video w-full rounded-xl" />
        ) : (
          <Empty className="aspect-video rounded-xl border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Video /></EmptyMedia>
              <EmptyTitle>No video to show yet</EmptyTitle>
              <EmptyDescription>{problem || 'Upload a video to see the player here.'}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        </div>
        <div className="grid gap-6">
        <Lock locked={locked} className="grid gap-4">
          <Section title="Look" bodyClassName="grid gap-5 sm:grid-cols-2">
            <Field invalid={!!problems.accent}>
              <FieldLabel htmlFor="p-accent">Accent colour</FieldLabel>
              <div className="flex gap-2">
                <input type="color" aria-label="Pick a colour" value={/^#[0-9a-fA-F]{6}$/.test(draft.accent) ? draft.accent : '#000000'} onChange={(e) => set({ accent: e.target.value })} className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1" />
                <Input id="p-accent" value={draft.accent} onChange={(e) => set({ accent: e.target.value })} className="font-mono" aria-invalid={(!!problems.accent) ? true : undefined} />
              </div>
              {problems.accent ? <FieldError>{problems.accent}</FieldError> : <FieldDescription>Used for the progress bar and the big play button.</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel>Light or dark controls</FieldLabel>
              <ToggleGroup variant="outline" value={[draft.theme]} onValueChange={([t]) => t && set({ theme: t as PlayerSettings['theme'] })}>
                <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
                <ToggleGroupItem value="light">Light</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field invalid={!!problems.logo_url}>
              <FieldLabel htmlFor="p-logo">Logo address</FieldLabel>
              <Input id="p-logo" value={draft.logo_url} onChange={(e) => set({ logo_url: e.target.value })} placeholder="https://example.com/logo.png" aria-invalid={(!!problems.logo_url) ? true : undefined} />
              {problems.logo_url ? <FieldError>{problems.logo_url}</FieldError> : <FieldDescription>A picture shown in the corner of the video. Leave empty for none.</FieldDescription>}
            </Field>
            <Field invalid={!!problems.logo_link}>
              <FieldLabel htmlFor="p-link">Logo link</FieldLabel>
              <Input id="p-link" value={draft.logo_link} onChange={(e) => set({ logo_link: e.target.value })} placeholder="https://example.com" aria-invalid={(!!problems.logo_link) ? true : undefined} />
              {problems.logo_link ? <FieldError>{problems.logo_link}</FieldError> : <FieldDescription>Where the logo takes viewers when they click it.</FieldDescription>}
            </Field>
          </Section>
          <Section title="Template" description={current ? 'A starting point for how the player behaves. It sets the switches below and keeps your look.' : 'Your own mix of the switches below. Pick a template to start again from one.'}>
              {templates.length ? (
                <RadioGroup value={current} onValueChange={(k) => { const t = templates.find((x) => x.key === k); if (t) set(t.settings) }}>
                  {templates.map((t) => (
                    <Field key={t.key} className="flex-row items-start gap-3">
                      <RadioGroupItem value={t.key} id={`tpl-${t.key}`} />
                      <div className="flex flex-1 flex-col gap-1">
                        <FieldLabel htmlFor={`tpl-${t.key}`}>{t.name}</FieldLabel>
                        <FieldDescription>{t.description}</FieldDescription>
                      </div>
                    </Field>
                  ))}
                </RadioGroup>
              ) : (
                <Skeleton className="h-40 w-full" />
              )}
          </Section>
          <Section title="When it plays" bodyClassName="flex flex-col gap-4">
              <Switches rows={PLAYBACK} draft={draft} set={set} />
          </Section>
          <Section title="Buttons viewers see" bodyClassName="flex flex-col gap-4">
              <Switches rows={CONTROLS} draft={draft} set={set} />
              <Field className="flex-row items-start gap-3">
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel>Skip buttons</FieldLabel>
                  <FieldDescription>Buttons that jump back or forward by this much.</FieldDescription>
                </div>
                <Select items={SKIPS} value={String(draft.skip)} onValueChange={(s) => s && set({ skip: Number(s) as PlayerSettings['skip'] })}>
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {SKIPS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
          </Section>
        </Lock>
        {lib && (
          <Section title="Put it on your page" bodyClassName="grid gap-3">
              <p className="text-sm text-muted-foreground">Paste this where the video should appear. Videos set to signed need <code>?token=</code> and a pass from your server after the address.</p>
              <Code code={snippet} label="HTML" />
          </Section>
        )}
        </div>
      </div>
    </div>
  )
}

// example.com or *.example.com, as TagInput's check.
const website = (raw: string) => {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return validHostname(s.replace(/^\*\./, '')) ? { value: s } : { problem: 'Use a website like example.com, or *.example.com for all its subdomains.' }
}

export function SecurityTab({ lib }: { lib?: Library }) {
  const defaults = useGet<VideoDefaults>(lib ? null : DEFAULTS)
  const { locked, bar } = useInherit(lib, 'security')
  const now = lib ?? defaults.data
  if (!lib && defaults.error) return <LoadError error={defaults.error} retry={defaults.refetch} />
  if (!now) return <Skeleton className="h-64 w-full max-w-2xl" />
  return (
    <>
      {bar}
      <SecurityEditor key={JSON.stringify([now.allowed_domains, now.blocked_domains, now.country_mode, now.countries, now.default_playback_policy])} lib={lib} now={now} locked={locked} />
    </>
  )
}

type Access = Pick<Library, 'allowed_domains' | 'blocked_domains' | 'country_mode' | 'countries' | 'default_playback_policy'>
const WEBSITE_MODES = [
  { value: 'any', label: 'Any website' },
  { value: 'only', label: 'Only these websites' },
  { value: 'except', label: 'Every website except these' },
]
const COUNTRY_MODES = [
  { value: 'everywhere', label: 'Everywhere' },
  { value: 'only', label: 'Only these countries' },
  { value: 'except', label: 'Everywhere except these' },
]

function SecurityEditor({ lib, now, locked }: { lib?: Library; now: Access; locked: boolean }) {
  const [policy, setPolicy] = useState<Policy>(now.default_playback_policy)
  const [websiteMode, setWebsiteMode] = useState(now.allowed_domains.length ? 'only' : now.blocked_domains.length ? 'except' : 'any')
  const [websites, setWebsites] = useState(now.allowed_domains.length ? now.allowed_domains : now.blocked_domains)
  const [countryMode, setCountryMode] = useState(now.country_mode === 'deny' ? 'only' : now.countries.length ? 'except' : 'everywhere')
  const [countries, setCountries] = useState(now.countries)
  const discard = () => (setPolicy(now.default_playback_policy), setWebsiteMode(now.allowed_domains.length ? 'only' : now.blocked_domains.length ? 'except' : 'any'), setWebsites(now.allowed_domains.length ? now.allowed_domains : now.blocked_domains), setCountryMode(now.country_mode === 'deny' ? 'only' : now.countries.length ? 'except' : 'everywhere'), setCountries(now.countries))
  const [busy, setBusy] = useState(false)
  const body = {
    default_playback_policy: policy,
    allowed_domains: websiteMode === 'only' ? websites : [],
    blocked_domains: websiteMode === 'except' ? websites : [],
    country_mode: countryMode === 'only' ? 'deny' : 'allow',
    countries: countryMode === 'everywhere' ? [] : countries,
  }
  const changed = JSON.stringify(body) !== JSON.stringify({ default_playback_policy: now.default_playback_policy, allowed_domains: now.allowed_domains, blocked_domains: now.blocked_domains, country_mode: now.country_mode, countries: now.countries })

  async function submit() {
    setBusy(true)
    if (lib) await save(`/v1/libraries/${lib.id}`, 'PATCH', body)
    else await save(DEFAULTS, 'PUT', body, NOTE)
    setBusy(false)
  }
  return (
    <Section
      className="max-w-2xl"
      title="Who can watch"
      action={<SaveBar dirty={changed && !locked} saving={busy} onSave={() => void submit()} onDiscard={discard} />}
    >
        <Lock locked={locked} className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Who can watch new uploads</FieldLabel>
            <RadioGroup value={policy} onValueChange={(p) => setPolicy(p as Policy)}>
              <Field className="flex-row items-start gap-3">
                <RadioGroupItem value="public" id="pol-public" />
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor="pol-public">Anyone with the link</FieldLabel>
                  <FieldDescription>Public: no pass needed.</FieldDescription>
                </div>
              </Field>
              <Field className="flex-row items-start gap-3">
                <RadioGroupItem value="signed" id="pol-signed" />
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor="pol-signed">Only people your server allows</FieldLabel>
                  <FieldDescription>Signed: your server gives each viewer a short-lived pass. Best for paid or private videos.</FieldDescription>
                </div>
              </Field>
            </RadioGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor="website-mode">Websites that can show the player</FieldLabel>
            <Choose id="website-mode" value={websiteMode} onChange={setWebsiteMode} options={WEBSITE_MODES} />
          </Field>
          {websiteMode !== 'any' && (
            <TagInput label={websiteMode === 'only' ? 'Allowed websites' : 'Blocked websites'} value={websites} onChange={setWebsites} check={website} max={50} placeholder="example.com"
              hint="Use *.example.com to include all of a website’s subdomains. Press Enter after each one." />
          )}
          <Field>
            <FieldLabel htmlFor="country-mode">Countries viewers can watch from</FieldLabel>
            <Choose id="country-mode" value={countryMode} onChange={setCountryMode} options={COUNTRY_MODES} />
            <FieldDescription>Found from each viewer’s internet address, on the player and on the video stream itself.</FieldDescription>
          </Field>
          {countryMode !== 'everywhere' && (
            <CountryPicker label={countryMode === 'only' ? 'Allowed countries' : 'Blocked countries'} value={countries} onChange={setCountries} max={250} />
          )}
          {countryMode === 'only' && countries.length === 0 && (
            <Alert variant="warning"><AlertDescription>With no countries listed, nobody can watch.</AlertDescription></Alert>
          )}
          <Alert>
            <AlertDescription>These stop casual copying and keep videos to the places you choose. They don’t stop someone determined: for that, set videos to signed so every viewer needs a pass from your server.</AlertDescription>
          </Alert>
        </Lock>
    </Section>
  )
}
