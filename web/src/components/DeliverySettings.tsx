import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CdnLogo } from '@/components/CdnLogo'
import { CircleQuestionMark, ExternalLink, Info } from '@/components/icons'
import { Code } from '@/components/Code'
import { CopyButton } from '@/components/CopyButton'
import { PageHeader } from '@/components/PageHeader'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Section } from '@/components/Section'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from '@/components/ui/preview-card'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { message, say } from '@/lib/messages'
import { validCDNURL } from '@/lib/schemas'
import { queryClient, useGet } from '@/lib/query'
import { toast } from '@/lib/toast'
import { SaveBar } from '@/components/SaveBar'

type Provider = 'ulka' | 'cloudflare' | 'cloudfront' | 'bunny' | 'fastly' | 'akamai' | 'other'
type Delivery = {
  mode: 'origin' | 'custom'
  modes: string[]
  custom_url: string
  provider: Provider
  origin: string
  cdn_distribution: { id: string; name: string; hostname: string; active: boolean } | null
  serving: string
}

const MODES = [
  { value: 'custom' as const, title: 'Through a CDN', text: 'Ulka CDN, Cloudflare, CloudFront, Bunny, Fastly, Akamai or any other. Copies of your videos sit close to viewers, so they start fast and this server does less work.' },
  { value: 'origin' as const, title: 'Directly from this server', text: 'No CDN. Fine while only a few people watch at a time; slower for far-away viewers.' },
]
// Ulka's own CDN, offered beside the others: people running ulka-vms may not know it exists.
const ULKA_CONSOLE = 'https://console.ulka.co'
const PROVIDERS: { value: Provider; name: string }[] = [
  { value: 'ulka', name: 'Ulka CDN' },
  { value: 'cloudflare', name: 'Cloudflare' },
  { value: 'cloudfront', name: 'Amazon CloudFront' },
  { value: 'bunny', name: 'Bunny' },
  { value: 'fastly', name: 'Fastly' },
  { value: 'akamai', name: 'Akamai' },
  { value: 'other', name: 'Another CDN' },
]
const example: Record<Provider, string> = {
  ulka: 'https://yourname.ulkanetworks.com',
  cloudflare: 'https://video.example.com',
  cloudfront: 'https://d111111abcdef8.cloudfront.net',
  bunny: 'https://yourzone.b-cdn.net',
  fastly: 'https://yourname.freetls.fastly.net',
  akamai: 'https://video.example.com',
  other: 'https://video.example.com',
}

const C = ({ children }: { children: ReactNode }) => <code>{children}</code>
const B = ({ children }: { children: ReactNode }) => <strong className="font-medium text-foreground">{children}</strong>
// open: the console page for the step; docs: the provider's own page about it. Checked against each provider's docs, October 2026.
type Step = { title: string; body: ReactNode; copy?: [string, string]; code?: string; open?: string; docs?: string }

function steps(provider: Provider, origin: string, host: string): Step[] {
  switch (provider) {
    case 'ulka':
      return [
        { title: 'Create a distribution', body: <>Sign in to Ulka and choose <B>CDN</B> → <B>Distributions</B> → <B>New distribution</B> (a distribution is one CDN setup). For where your files live, choose your server and paste the address below.</>, copy: ['Origin', origin], open: `${ULKA_CONSOLE}/cdn/distributions?new=1` },
        { title: 'Choose video caching', body: <>At <B>Caching</B>, choose <B>Video</B>: playlists stay fresh and video pieces are kept for 30 days. Ulka keeps the query string, so private videos' <C>?token=</C> stays part of each copy.</> },
        { title: 'Wait until it is live', body: <>The distribution shows <B>Live</B> within a few minutes. Its address looks like <C>yourname.ulkanetworks.com</C>; you can add your own domain on its <B>Domains</B> page.</> },
        { title: 'Tell this server', body: <>Enter the distribution's address below, with <C>https://</C> and nothing after it.</> },
      ]
    case 'cloudflare':
      return [
        { title: 'Open your domain in Cloudflare', body: <>Sign in and pick the domain viewers will use. It must use Cloudflare's nameservers. Read Cloudflare's terms first: on Free, Pro and Business plans they may limit accounts that mostly serve video.</>, open: 'https://dash.cloudflare.com', docs: 'https://www.cloudflare.com/service-specific-terms-application-services/' },
        { title: 'Create a Worker', body: <>Cloudflare must ask your server by its own name, and only Enterprise plans can set that in a rule. On other plans a small Worker (a script Cloudflare runs) does it: <B>Workers & Pages</B> → <B>Create</B> → <B>Start with Hello World</B>, replace the code with this, then <B>Deploy</B>. Use Workers Paid: the free plan stops at 100,000 requests a day.</>, code: `export default {\n  fetch(request) {\n    const url = new URL(request.url)\n    url.hostname = "${host}"\n    return fetch(url, request)\n  },\n}`, open: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages', docs: 'https://developers.cloudflare.com/workers/examples/bulk-origin-proxy/' },
        { title: 'Give the Worker your address', body: <>Open the Worker → <B>Settings</B> → <B>Domains & Routes</B> → <B>Add</B> → <B>Custom Domain</B>, and enter a name like <C>video.example.com</C>. Cloudflare adds the DNS record and its certificate.</>, docs: 'https://developers.cloudflare.com/workers/configuration/routing/custom-domains/' },
        { title: 'Let Cloudflare cache the video', body: <><B>Caching</B> → <B>Cache Rules</B> → <B>Create rule</B>: when the hostname equals your address, choose <B>Eligible for cache</B>, Edge TTL <B>Use cache-control header if present</B>, Browser TTL <B>Respect origin</B>. Leave the cache key as it is, so private videos' <C>?token=</C> stays part of it.</>, open: 'https://dash.cloudflare.com/?to=/:account/:zone/caching/cache-rules', docs: 'https://developers.cloudflare.com/cache/how-to/cache-rules/settings/' },
        { title: 'Keep HTTPS strict', body: <><B>SSL/TLS</B> → <B>Overview</B>: choose <B>Full (strict)</B>, so Cloudflare checks the server's certificate.</>, docs: 'https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/' },
        { title: "Don't add sharing headers", body: <>Add no rule that sets <C>Access-Control-Allow-Origin</C>. The server sends it already, and two copies stop videos playing in browsers.</> },
        { title: 'Tell this server', body: <>Enter your address below, like <C>https://video.example.com</C>, with nothing after it. On Enterprise you can skip the Worker: a CNAME to the host above, proxied, plus an Origin Rule that sets the Host header and SNI to it.</>, copy: ['Ulka VMS host', host] },
      ]
    case 'cloudfront':
      return [
        { title: 'Make a cache policy', body: <>In CloudFront, <B>Policies</B> → <B>Create cache policy</B>, named <C>ulka-video</C>: minimum TTL 0, default 86400, maximum 31536000; headers <B>None</B>, cookies <B>None</B>, query strings <B>All</B> (private videos carry <C>?token=</C>). On flat-rate plans this needs Business or Premium; pay-as-you-go also works.</>, open: 'https://console.aws.amazon.com/cloudfront/v4/home#/policies', docs: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-key-create-cache-policy.html' },
        { title: 'Create a distribution', body: <><B>Distributions</B> → <B>Create distribution</B>, give it a name and pick a plan (the free plan's 1 million requests a month is too small for video), then <B>Single website or app</B>.</>, open: 'https://console.aws.amazon.com/cloudfront/v4/home#/distributions', docs: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-creating-console.html' },
        { title: 'Point it at your server', body: <>Origin: the host below, with no <C>https://</C>. <B>Customize origin settings</B>: protocol <B>HTTPS only</B>, port 443, minimum TLSv1.2.</>, copy: ['Origin domain', host], docs: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html' },
        { title: 'Set caching', body: <>Allowed methods <B>GET, HEAD, OPTIONS</B>; cache policy <C>ulka-video</C>; origin request policy <B>None</B>; response headers policy <B>None</B>. Avoid <C>AllViewer</C> and the <C>UseOriginCacheControlHeaders</C> policies: they send your CloudFront name to the server, which refuses it.</>, docs: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html' },
        { title: 'Create it and wait', body: <>The firewall (AWS WAF) is optional. Choose <B>Create distribution</B> and wait until its status shows a date instead of <B>Deploying</B>.</> },
        { title: 'Optional: your own address', body: <>In the distribution, <B>Settings</B> → <B>Alternate domain names</B> → <B>Add a domain</B>, with a certificate made in us-east-1; then CNAME your name to the <C>d….cloudfront.net</C> address.</>, docs: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-domain-existing-distribution.html' },
        { title: 'Tell this server', body: <>Copy <B>Distribution domain name</B> from the <B>General</B> tab, put <C>https://</C> in front, and enter it below (or your own address).</> },
      ]
    case 'bunny':
      return [
        { title: 'Add a pull zone', body: <>Sign in to bunny.net and choose <B>+ Add</B> → <B>Add Pull Zone</B> (a pull zone is one CDN setup). Its name, letters and numbers only, becomes <C>name.b-cdn.net</C>.</>, open: 'https://dash.bunny.net', docs: 'https://bunny.net/docs/cdn/quickstart' },
        { title: 'Point it at your server', body: <>Choose <B>Origin URL</B> and paste the address below. Leave <B>Host header</B> empty, so Bunny asks the server by its own name.</>, copy: ['Origin URL', origin], docs: 'https://bunny.net/docs/cdn/request-headers-to-origin' },
        { title: 'Pick the video tier', body: <>Choose <B>High Volume</B>, made for large files and video, pick your regions and select <B>Add Pull Zone</B>.</> },
        { title: "Follow the server's cache times", body: <><B>Caching</B>: set <B>Cache expiration time</B> to <B>Respect origin Cache-Control</B>. Leave <B>Smart Cache</B> off: it skips the video's <C>.m4s</C> pieces.</>, docs: 'https://bunny.net/docs/cdn/smart-cache' },
        { title: 'Keep private videos private', body: <><B>Caching</B> → <B>General</B>: turn on <B>URL Query String</B> under Vary Cache and save. Bunny ignores query strings by default, which would hand one viewer's private video to everyone.</>, docs: 'https://bunny.net/docs/cdn/vary-cache' },
        { title: "Don't forward your address", body: <>Keep <B>Forward Host Header</B> off (the default), and add no CORS headers for video files: the server sends its own.</> },
        { title: 'Optional: your own address', body: <><B>General</B> → <B>Hostnames</B>: add <C>video.example.com</C>, create the CNAME it shows, then <B>Verify & Activate SSL</B>.</>, docs: 'https://bunny.net/docs/cdn/custom-hostname' },
        { title: 'Tell this server', body: <>Enter <C>https://name.b-cdn.net</C> or your own address below.</> },
      ]
    case 'fastly':
      return [
        { title: 'Create a CDN service', body: <>Sign in to Fastly, choose <B>Create service</B> → <B>CDN</B>, and name it. For <B>Domain</B>, use your own or a free one like <C>yourname.global.ssl.fastly.net</C>.</>, open: 'https://manage.fastly.com', docs: 'https://www.fastly.com/documentation/solutions/tutorials/deliver-your-distribution/' },
        { title: 'Point it at your server', body: <>In <B>Host</B>, enter the host below and choose <B>Activate</B>.</>, copy: ['Host', host], docs: 'https://www.fastly.com/documentation/guides/getting-started/services/working-with-cdn-services/' },
        { title: "Use the server's own name", body: <><B>Edit configuration</B> → clone the active version → <B>Origins</B> → edit the host: TLS <B>Yes</B>, port 443, verify certificate <B>Yes</B>; set <B>Certificate hostname</B> and <B>Override host</B> to the host above and tick <B>match SNI hostname</B>. Then <B>Activate</B> → <B>Activate on Production</B>.</>, docs: 'https://www.fastly.com/documentation/guides/full-distribution-delivery/domains-and-origins/specifying-an-override-host/' },
        { title: 'Leave caching as it is', body: <>Fastly follows the server's cache headers and keeps the full address, query included, in its cache key. Add no cache-time overrides.</>, docs: 'https://www.fastly.com/documentation/guides/full-distribution-delivery/caching/caching-best-practices/' },
        { title: 'Optional: your own address', body: <><B>Domains</B> → <B>Add domain</B> with a Fastly-managed certificate, add the <C>_acme-challenge</C> record it shows, then CNAME your name to the address Fastly gives.</>, docs: 'https://www.fastly.com/documentation/guides/getting-started/domains/working-with-domains/working-with-domains/' },
        { title: 'Tell this server', body: <>Enter <C>https://yourname.freetls.fastly.net</C> or your own address below.</> },
      ]
    case 'akamai':
      return [
        { title: 'Create a property', body: <>In Akamai Control Center, <B>Content delivery</B> → <B>CDN</B> → <B>Properties</B> → <B>New Property</B>, then <B>Adaptive Media Delivery</B> (a property is one CDN setup). Add your name, like <C>video.example.com</C>, as a property hostname.</>, open: 'https://control.akamai.com', docs: 'https://techdocs.akamai.com/adaptive-media-delivery/docs/create-new-prop' },
        { title: 'Point it at your server', body: <><B>Origin Server</B>: type <B>Your Origin</B>, hostname the host below; <B>Forward Host Header</B> and <B>Cache Key Hostname</B> both <B>Origin Hostname</B>; HTTPS port 443 with <B>Use SNI TLS Extension</B> on.</>, copy: ['Origin hostname', host], docs: 'https://techdocs.akamai.com/property-mgr/docs/origin-server' },
        { title: 'Say it is on-demand video', body: <><B>Segmented Media Delivery Mode</B>: <B>On Demand</B>.</>, docs: 'https://techdocs.akamai.com/adaptive-media-delivery/docs/segmented-media-deliv-mode-amd' },
        { title: 'Keep private videos private', body: <><B>Cache Key Query Parameters</B>: change <B>Exclude all parameters</B> to <B>Include all parameters (preserve order from request)</B>, or one viewer's private video is served to everyone.</>, docs: 'https://techdocs.akamai.com/adaptive-media-delivery/docs/cache-key-query-param-amd' },
        { title: "Follow the server's cache times", body: <>Add a <B>Caching</B> behavior to the Default Rule with <B>Honor origin Cache-Control</B>.</>, docs: 'https://techdocs.akamai.com/property-mgr/docs/caching-2' },
        { title: 'Remove the default sharing rule', body: <>Delete the <B>Default CORS Policy Rule</B>: it replaces the server's own <C>Access-Control-Allow-Origin</C>.</>, docs: 'https://techdocs.akamai.com/adaptive-media-delivery/docs/default-cors-policy-rule' },
        { title: 'Test, then go live', body: <><B>Save</B>, activate on Staging and test, then <B>Activate on Production</B>. CNAME your name to the edge hostname Akamai made (<C>…akamaized.net</C>).</>, docs: 'https://techdocs.akamai.com/adaptive-media-delivery/docs/go-live' },
        { title: 'Tell this server', body: <>Enter <C>https://video.example.com</C> below.</> },
      ]
    default:
      return [
        { title: 'Create a pull setup', body: <>Make your CDN's "pull zone", "distribution" or "resource": the kind that fetches from an origin.</> },
        { title: 'Point it at your server', body: <>HTTPS on port 443. Paste the full address if the field asks for a URL, or only the host if it asks for a host or domain.</>, copy: ['Origin', origin] },
        { title: "Use the server's own name", body: <>The Host header and SNI (the name in the secure handshake) must both be <C>{host}</C>. Turn off any "forward viewer host" option: the server refuses other names.</> },
        { title: "Follow the server's cache times", body: <>Choose "respect origin" or "honor Cache-Control", with a minimum cache time of 0.</> },
        { title: 'Keep the query string', body: <>Keep every query parameter in the cache key and pass it on. Private videos use <C>?token=</C>; ignoring it would serve one viewer's video to everyone.</> },
        { title: "Don't add sharing headers", body: <>Turn off any "add CORS headers" option: the server sends <C>Access-Control-Allow-Origin</C>, and two copies stop browsers playing. Allow GET, HEAD and OPTIONS.</> },
        { title: 'Tell this server', body: <>Enter the address viewers download from below, with <C>https://</C> and nothing after it.</> },
      ]
  }
}

export function DeliverySettings() {
  const query = useGet<Delivery>('/v1/video/delivery')
  const current = query.data ?? null
  const problem = query.error ? message(query.error) : ''
  const [mode, setMode] = useState<Delivery['mode']>('origin')
  const [provider, setProvider] = useState<Provider>('ulka')
  const [customURL, setCustomURL] = useState('')
  const [urlProblem, setUrlProblem] = useState('')
  const [busy, setBusy] = useState(false)
  // The form starts from the saved settings once; a background refresh never overwrites what's being edited.
  const seeded = useRef(false)
  useEffect(() => {
    const d = query.data
    if (!d || seeded.current) return
    seeded.current = true
    setMode(d.mode)
    setProvider(d.provider)
    setCustomURL(d.custom_url)
  }, [query.data])

  async function save() {
    const bad = mode === 'custom' && !validCDNURL(customURL)
    setUrlProblem(bad ? say('invalid_delivery') : '')
    if (bad) return
    setBusy(true)
    try {
      queryClient.setQueryData(['/v1/video/delivery'], await api<Delivery>('PUT', '/v1/video/delivery', { mode, provider, custom_url: mode === 'custom' ? customURL : '' }))
      toast('Saved. Videos started from now on use it. Anyone already watching keeps their current connection until they reload the page.')
    } catch (err) {
      toast(message(err), 'danger')
    } finally {
      setBusy(false)
    }
  }
  const changed = !!current && (mode !== current.mode || (mode === 'custom' && (customURL !== current.custom_url || provider !== current.provider)))
  const originHost = current ? current.origin.replace(/^https?:\/\//, '') : ''
  const note = 'text-xs text-muted-foreground'

  return (
    <section id="delivery" className="grid max-w-3xl grid-cols-1 gap-6">
      <PageHeader title="Delivery" level={2} actions={<>
  {current && <SaveBar dirty={changed} saving={busy} onSave={() => void save()} onDiscard={() => (setUrlProblem(''), setMode(current.mode), setProvider(current.provider), setCustomURL(current.custom_url))} />}
  <PreviewCard>
    <PreviewCardTrigger render={<button type="button" aria-label="What goes through this choice?" className="inline-grid align-middle" />}>
        <CircleQuestionMark size={14} />
      </PreviewCardTrigger>
    <PreviewCardPopup className="w-72 text-xs text-muted-foreground">Only the heavy video files travel through the option you pick. This server always serves the small parts that check who may watch, so private videos stay private.</PreviewCardPopup>
  </PreviewCard>
      </>} />

      {problem && (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {!current ? (
        !problem && <Skeleton className="h-48 w-full" />
      ) : (
        <>
          <Alert variant="info">
            <Info />
            <AlertDescription>
              Viewers are fetching from <code className="[overflow-wrap:anywhere]">{current.serving}</code>
            </AlertDescription>
          </Alert>
          <RadioGroup value={mode} onValueChange={(m) => setMode(m as Delivery['mode'])} aria-label="Delivery">
            {MODES.filter((o) => current.modes.includes(o.value)).map((o) => (
              <Label key={o.value} className="flex items-start gap-3 rounded-lg border p-4 hover:bg-accent/50 has-data-checked:border-primary/48 has-data-checked:bg-accent/50">
                <div className="flex flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2 font-medium">
                    {o.title}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">{o.text}</span>
                </div>
                <RadioGroupItem value={o.value} />
              </Label>
            ))}
          </RadioGroup>

          {mode === 'custom' ? (
            <Section title="Set up your CDN" description="Pick your provider for its steps, each with a link to the page in its console and its own guide. Checked against their docs in October 2026; consoles change, so their guide wins if a label differs." bodyClassName="grid gap-4">
                <RadioGroup value={provider} onValueChange={(p) => setProvider(p as Provider)} aria-label="CDN provider" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {PROVIDERS.map((p) => (
                    <Field key={p.value} className="relative flex-row items-center gap-2 rounded-lg border bg-background p-3 has-data-checked:border-primary">
                      <RadioGroupItem value={p.value} id={`provider-${p.value}`} />
                      <FieldLabel htmlFor={`provider-${p.value}`} className="flex items-center gap-2 font-normal after:absolute after:inset-0">
                        <CdnLogo provider={p.value} />
                        {p.name}
                      </FieldLabel>
                    </Field>
                  ))}
                </RadioGroup>
                <p className="text-sm text-muted-foreground">
                  These steps use your CDN's own words. The <strong>origin</strong> is where your CDN fetches the videos from, which is this server. A <strong>CNAME</strong> record is a DNS setting that points a name you own, like video.example.com, at another address. Your developer or domain provider can do this part.
                </p>
                <ol className="grid gap-4">
                  {steps(provider, current.origin, originHost).map((s, i) => (
                    <li key={s.title} className="text-sm text-muted-foreground">
                      <strong className="block text-foreground">
                        {i + 1}. {s.title}
                      </strong>
                      {s.body}
                      {s.code && <div className="mt-2"><Code label="Worker code" lang="ts" code={s.code} /></div>}
                      {s.copy && (
                        <InputGroup className="mt-2">
                          <InputGroupInput readOnly value={s.copy[1]} aria-label={s.copy[0]} className="font-mono" />
                          <InputGroupAddon align="inline-end">
                            <CopyButton value={s.copy![1]} what={s.copy![0].toLowerCase()} />
                          </InputGroupAddon>
                        </InputGroup>
                      )}
                      {(s.open || s.docs) && (
                        <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                          {s.open && <a href={s.open} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">Open in {PROVIDERS.find((p) => p.value === provider)?.name}<ExternalLink className="size-3.5" /></a>}
                          {s.docs && <a href={s.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">Their guide<ExternalLink className="size-3.5" /></a>}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
                <Field>
                  <FieldLabel htmlFor="cdn-address">Your CDN's address</FieldLabel>
                  <Input id="cdn-address" value={customURL} onChange={(e) => (setCustomURL(e.target.value), setUrlProblem(''))} placeholder={example[provider]} aria-invalid={!!urlProblem || undefined} />
                  {urlProblem ? <FieldError>{urlProblem}</FieldError> : <FieldDescription>The web address your CDN gives viewers. Copy it from your CDN after the steps above.</FieldDescription>}
                </Field>
            </Section>
          ) : (
            <p className={note}>
              Need a CDN? <a href="https://ulka.co" target="_blank" rel="noreferrer" className="text-primary hover:underline">Ulka CDN</a> serves video from servers close to your viewers and works with this server as it is.
            </p>
          )}

        </>
      )}
    </section>
  )
}
