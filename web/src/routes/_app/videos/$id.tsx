import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { LoadError } from '@/components/LoadError'
import { CopyButton } from '@/components/CopyButton'
import * as v from 'valibot'
import { AppLink, useGo } from '@/components/AppLink'
import { Code } from '@/components/Code'
import { Ladder } from '@/components/Ladder'
import { Meta } from '@/components/Meta'
import { Player } from '@/components/player/Player'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { FormDialog, Wizard } from '@/components/Wizard'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Section } from '@/components/Section'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { api, ApiError, type Asset, type Caption, type Folder, type Library, type Policy, type Technical as Tech } from '@/lib/api'
import { ago, size, timecode, when } from '@/lib/format'
import { message, say, videoProblem } from '@/lib/messages'
import { refresh, useGet } from '@/lib/query'
import { useCrumb } from '@/lib/crumb'
import { pathTo } from '@/components/library/FolderTree'
import { PrivacyMenu, embedOf, signedLink } from '@/components/library/Privacy'
import { usePreview } from '@/lib/preview'
import { ThumbnailCard, TimelinePictures } from '@/components/library/Pictures'
import { VideoTimeline } from '@/components/library/VideoTimeline'
import { PlaybackCheck } from '@/components/library/PlaybackCheck'
import { LinkCheck } from '@/components/library/LinkCheck'
import { ViewerReports } from '@/components/library/ViewerReports'
import { SignedLinkDialog } from '@/components/library/SignedLinkDialog'
import { Facts } from '@/components/Facts'
import { Technical } from '@/components/Technical'
import { AboutVideo, VideoChapters, VideoMetadata } from '@/components/library/VideoDetails'
import * as schema from '@/lib/schemas'
import { statusBadge } from '@/lib/status'
import { Working } from '@/components/Working'
import { retryVideo } from '@/lib/retry'
import { badgeVariant } from '@/lib/tone'
import { toast } from '@/lib/toast'
import { useSetParams } from '@/hooks/use-set-params'
import { StatusBadge } from '@/components/StatusBadge'
import { InlineEdit } from '@/components/InlineEdit'
import { Copy, Download, Ellipsis, Pencil, Plus, RefreshCw, Trash2 } from '@/components/icons'
import { copy } from '@/lib/copy'
import { rules } from '@/lib/rules'

export const Route = createFileRoute('/_app/videos/$id')({
  validateSearch: (s: Record<string, unknown>) => ({ tab: typeof s.tab === 'string' ? s.tab : '' }),
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  // Refreshes while the video is still being made, and while its download is.
  const assetQ = useGet<Asset>(`/v1/assets/${id}`, (q) => (q.state.data?.status === 'complete' || q.state.data?.status === 'errored' ? (q.state.data.download === 'preparing' ? 3000 : false) : 2000))
  const asset = assetQ.data
  const every = asset && (asset.status === 'complete' || asset.status === 'errored') ? (asset.download === 'preparing' ? 3000 : undefined) : 2000
  const captionsQ = useGet<{ data: Caption[] }>(`/v1/assets/${id}/captions`, every)
  const libQ = useGet<Library>(asset ? `/v1/libraries/${asset.library_id}` : null)
  const foldersQ = useGet<{ data: Folder[] }>(asset ? `/v1/libraries/${asset.library_id}/folders` : null)
  const folderSteps = asset ? pathTo(foldersQ.data?.data ?? [], asset.folder_id ?? null).map((f) => ({ label: f.name, href: `/videos/library/${asset.library_id}?folder=${f.id}` })) : []
  useCrumb(asset ? asset.title || asset.passthrough || 'Untitled video' : '', '', [], asset && libQ.data ? [{ label: libQ.data.name, href: `/videos/library/${asset.library_id}` }, ...folderSteps] : [])

  if (assetQ.error instanceof ApiError && assetQ.error.status === 404)
    return (
      <div className="grid justify-items-start gap-3 py-12">
        <h1 className="text-xl font-semibold">Nothing here</h1>
        <p className="text-muted-foreground">This video doesn't exist, or it was deleted.</p>
        <Button render={<AppLink href="/videos" />}>Back to videos</Button>
      </div>
    )
  if (assetQ.error && !asset) return <LoadError error={assetQ.error} retry={assetQ.refetch} />
  const partError = captionsQ.error
  if (partError)
    return (
      <Alert variant="error">
        <AlertDescription>{message(partError)}</AlertDescription>
      </Alert>
    )
  if (!asset || !captionsQ.data) return <Skeleton className="h-64 w-full" />
  return <Video asset={asset} captions={captionsQ.data.data} />
}

function Video({ asset, captions }: { asset: Asset; captions: Caption[] }) {
  const go = useGo()
  const search = Route.useSearch()
  const setParams = useSetParams()
  const title = asset.title || asset.passthrough || 'Untitled video'
  const [renaming, setRenaming] = useState(false)
  const [trashing, setTrashing] = useState(false)
  const playable = asset.status === 'ready' || asset.status === 'complete'
  const badge = statusBadge[asset.status]
  const copyRow = (value: string, what: string) => (
    <InputGroup>
      <InputGroupInput readOnly value={value} aria-label={what} className="font-mono" />
      <InputGroupAddon align="inline-end">
        <CopyButton value={value} what={what} />
      </InputGroupAddon>
    </InputGroup>
  )

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'playback', label: 'Playback' },
    { id: 'thumbnail', label: 'Thumbnail' },
    { id: 'qualities', label: 'Qualities' },
    { id: 'troubleshoot', label: 'Troubleshoot' },
    { id: 'technical', label: 'Technical' },
  ]
  // Details are part of the Overview now; old links land there.
  const asked = search.tab === 'details' ? 'overview' : search.tab
  const tab = tabs.some((t) => t.id === asked) ? asked : 'overview'

  const { preview, problem: previewProblem, noKey } = usePreview(asset)
  // A private video's addresses show where the signature from the customer's server goes.
  const signed = asset.playback_policy === 'signed'
  const page = signed ? signedLink(asset.embed_url) : asset.embed_url
  const src = signed ? signedLink(asset.playback_url) : asset.playback_url

  const [busy, setBusy] = useState(false)
  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
      await refresh(`/v1/assets/${asset.id}`)
      return true
    } catch (err) {
      toast(message(err), 'danger')
      return false
    } finally {
      setBusy(false)
    }
  }
  const [signing, setSigning] = useState(false)
  const setPolicy = (policy: Policy) =>
    act(() => api('PATCH', `/v1/assets/${asset.id}`, { playback_policy: policy })).then((ok) => ok && toast(policy === 'public' ? 'Anyone with the link can watch now.' : 'Only signed links play it now.'))

  // Captions: the file goes to the API as it is (WebVTT or SRT); the API converts and checks it.
  const [addingCaptions, setAddingCaptions] = useState(false)
  const [captionStep, setCaptionStep] = useState(0)
  useEffect(() => {
    if (addingCaptions) setCaptionStep(0)
  }, [addingCaptions])
  const [captionFile, setCaptionFile] = useState<File | null>(null)
  const [captionLanguage, setCaptionLanguage] = useState('')
  const [captionName, setCaptionName] = useState('')
  const [captionProblems, setCaptionProblems] = useState<Record<string, string>>({})
  async function addCaptions() {
    const parsed = v.safeParse(
      v.object({
        file: v.pipe(v.nullable(v.instance(File)), v.check((f) => f !== null && f.size <= rules.limits.caption_bytes, schema.words('invalid_captions'))),
        language: v.pipe(v.string(), v.trim(), v.regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, schema.words('invalid_language'))),
        name: v.pipe(schema.name(), v.check((n) => !/["\n]/.test(n), schema.words('invalid_name'))),
      }),
      { file: captionFile, language: captionLanguage, name: captionName },
    )
    setCaptionProblems(parsed.success ? {} : schema.problemsOf(parsed.issues))
    if (!parsed.success) return setCaptionStep(parsed.issues[0].path?.[0]?.key === 'file' ? 0 : 1)
    setBusy(true)
    try {
      const q = new URLSearchParams({ language: parsed.output.language, name: parsed.output.name })
      await api('POST', `/v1/assets/${asset.id}/captions?${q}`, parsed.output.file)
      toast(`${parsed.output.name} captions added. Players show them on their next load.`)
      setAddingCaptions(false)
      setCaptionFile(null)
      setCaptionLanguage('')
      setCaptionName('')
      await refresh(`/v1/assets/${asset.id}`)
    } catch (err) {
      toast(message(err), 'danger')
    } finally {
      setBusy(false)
    }
  }

  async function deleteVideo() {
    setBusy(true)
    try {
      await api('POST', '/v1/assets/trash', { ids: [asset.id] })
      toast('Moved to the trash. You can restore it for 30 days.')
      await refresh('/v1/assets', '/v1/video/stats', '/v1/libraries')
      go(`/videos/library/${asset.library_id}`)
    } catch (err) {
      toast(message(err), 'danger')
      setBusy(false)
    }
  }

  const makeDownload = () => void act(() => api('POST', `/v1/assets/${asset.id}/download`)).then((ok) => ok && toast('Preparing the download. It will be ready here shortly.'))
  const small = 'text-xs text-muted-foreground'
  const deleteSheet = (
    <AlertDialog open={trashing} onOpenChange={setTrashing}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Move this video to the trash?</AlertDialogTitle>
          <AlertDialogDescription>It stops playing right away, including on pages where it is already embedded. You can restore it from the trash for 30 days; after that it is deleted for good.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Keep video</AlertDialogClose>
          <AlertDialogClose render={<Button variant="destructive" onClick={() => void deleteVideo()} />}>
            Move to trash
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )

  return (
    <div className="grid grid-cols-1 gap-6">
      <Meta title={title} description="Watch this video, copy its share links and manage captions and downloads." />

      <header className="flex items-start justify-between gap-4 [&>:not(:first-child)]:shrink-0">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">
            <InlineEdit
              value={title}
              label="Title"
              editing={renaming}
              onEditingChange={setRenaming}
              onSave={async (t) => {
                const ok = await act(() => api('PATCH', `/v1/assets/${asset.id}`, { title: t }))
                if (ok) toast('Video renamed.')
                else return "Couldn't rename it. Try again."
              }}
            />
          </h1>
          <p className="text-sm text-muted-foreground">
            {[timecode(asset.duration_seconds), asset.width ? `${asset.width}×${asset.height}` : '', `${asset.renditions?.length ?? 0} ${asset.renditions?.length === 1 ? 'quality' : 'qualities'}`, `added ${ago(asset.created_at)}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge variant={badgeVariant(badge.tone)}>{badge.text}</StatusBadge>
          <Menu>
            <MenuTrigger render={<Button variant="outline" />}>
              {busy && <Spinner />}
              Actions
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setRenaming(true)}>
                <Pencil />
                Rename
              </MenuItem>
              <MenuItem onClick={() => void copy(asset.id, 'Video ID')}>
                <Copy />
                Copy ID
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" disabled={busy} onClick={() => setTrashing(true)}>
                <Trash2 />
                Move to trash…
              </MenuItem>
            </MenuPopup>
          </Menu>
          {deleteSheet}
        </div>
      </header>



      {asset.status === 'errored' && (
        <Working
          phase="failed"
          title="We couldn't process this video"
          action={<Button size="sm" disabled={busy} onClick={() => void act(() => retryVideo(asset.id))}>Try again</Button>}
        >
          {videoProblem(asset.error_code)} If it keeps happening, contact us.
        </Working>
      )}
      {asset.status === 'waiting' && <Working phase="working" title="Waiting for the upload to finish…">Nothing happens until the whole file has arrived. Keep the upload window open.</Working>}
      {asset.status === 'processing' && <Working phase="working" title="Processing your video…">This takes a few minutes, longer for long or high-quality videos. You can leave this page; it carries on.</Working>}
      {asset.status === 'ready' && <Working phase="working" title="You can watch it now. We're still adding the other qualities…">It will be fully ready in a few minutes.</Working>}

      <Tabs value={tab} onValueChange={(id) => setParams({ tab: id === tabs[0].id ? '' : id })}>
        <TabsList className="h-auto flex-wrap">
          {tabs.map((t) => (
            <TabsTab key={t.id} value={t.id}>
              {t.label}
            </TabsTab>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid gap-6">
        {tab === 'overview' && (
          <>
          {/* The video wide, sharing beside it in a narrower column (about 2:1); stacked on smaller screens. */}
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="grid gap-6">
            <Section title="Preview">
                  {preview ? (
                    <Player src={preview.src} poster={preview.poster} storyboard={preview.storyboard} chapters={asset.chapters} />
                  ) : (
                    <div className="grid aspect-video place-items-center rounded-lg bg-muted p-6 text-center text-sm text-muted-foreground">
                      {noKey ? (
                        <p>
                          This video is private, so it needs a key to preview.{' '}
                          <AppLink href="/videos/signing-keys" className="text-primary">
                            Create a signing key
                          </AppLink>{' '}
                          to preview it here.
                        </p>
                      ) : previewProblem ? (
                        <p>{previewProblem}</p>
                      ) : asset.status === 'errored' ? (
                        <p>There is nothing to play.</p>
                      ) : (
                        <p>It's still being prepared. You can watch it here in a few minutes.</p>
                      )}
                    </div>
                  )}
              </Section>
            </div>
              <div className="grid gap-6">
              {playable && (
                <Section
                  title="Share it"
                  description={<>
                      Paste this on your website to show the video.{' '}
                      <button type="button" className="text-primary" onClick={() => setParams({ tab: 'playback' })}>
                        More ways to play, and downloads
                      </button>
                  </>}
                  bodyClassName="grid gap-3"
                >
                    <Code
                      label="Embed code"
                      code={embedOf(asset)}
                    />
                    {copyRow(src, 'Stream address')}
                </Section>
              )}
              <Section flush title="Basic info">
                  <Facts
                    rows={[
                      ['Status', <StatusBadge key="s" variant={badgeVariant(badge.tone)}>{badge.text}</StatusBadge>],
                      ['Length', asset.duration_seconds ? timecode(asset.duration_seconds) : 'Not known yet'],
                      ['Qualities', asset.renditions?.length ? asset.renditions.map((r) => r.name).join(', ') : 'Not made yet'],
                      ['Original file size', asset.size_bytes ? size(asset.size_bytes) : 'Not known yet'],
                      ['Added', when(asset.created_at)],
                    ]}
                  />
              </Section>
              </div>
            </div>
            <AboutVideo key={`about-${asset.updated_at}`} asset={asset} />
              <Section
                title="Subtitles"
                description="Subtitles viewers can switch on in the player, one per language."
                action={
                  <Button size="sm" variant="secondary" onClick={() => setAddingCaptions(true)}><Plus />
                    Add
                  </Button>
                }
              >
                {captions.length === 0 ? (
                  <p className="text-muted-foreground">None yet. Add a subtitle file for each language (a .vtt or .srt file, which most subtitle tools can save).</p>
                ) : (
                  <ul className="grid gap-2">
                    {captions.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
                        <span>
                          <strong>{c.name}</strong> <span className="text-muted-foreground">{c.language}</span>
                        </span>
                        <Menu>
                          <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name} captions`} disabled={busy} />}>
                            <Ellipsis />
                          </MenuTrigger>
                          <MenuPopup align="end">
                            <MenuItem variant="destructive" onClick={() => void act(() => api('DELETE', `/v1/assets/${asset.id}/captions/${c.id}`)).then((ok) => ok && toast(`${c.name} captions removed.`))}>
                              <Trash2 />
                              Remove
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      </li>
                    ))}
                  </ul>
                )}
            </Section>
            <VideoChapters key={`chapters-${asset.updated_at}`} asset={asset} />
            <VideoMetadata key={`meta-${asset.updated_at}`} asset={asset} />
            <Section title="Timeline" description="How getting the video ready went, step by step.">
                <VideoTimeline asset={asset} />
            </Section>
          </>
          )}

          {tab === 'troubleshoot' && (
            <>
              <PlaybackCheck path={`/v1/assets/${asset.id}/playback-check`} />
              <LinkCheck asset={asset.id} />
              <ViewerReports asset={asset.id} />
            </>
          )}

          {tab === 'technical' && <TechnicalTab asset={asset.id} />}

          {tab === 'thumbnail' && <ThumbnailCard asset={asset} at={preview?.at} />}

          {tab === 'qualities' && (
            <Section title="Qualities" description="Versions of the video at different sizes, so it plays smoothly on any connection. The smaller ones are made first so you can watch quickly; sharper ones follow.">
                <Ladder asset={asset} />
            </Section>
          )}

          {tab === 'playback' && (
            <>
              <Section
                title="Who can watch"
                description={asset.playback_policy === 'public'
                        ? 'Anyone with the link can watch. The address never changes, even if you make it private later.'
                        : "Only links your website's server signs for each viewer play it. The address shows where the signature goes."}
                action={<PrivacyMenu value={asset.playback_policy} onChange={(p) => void setPolicy(p)} disabled={busy} confirm />}
                bodyClassName="grid gap-3"
              >
                  <div className="grid gap-1">
                    <span className="text-xs text-muted-foreground">Watch page: open it in a browser, send it, or put it in an iframe</span>
                    {copyRow(page, 'Watch page')}
                  </div>
                  <div className="grid gap-1">
                    <span className="text-xs text-muted-foreground">Stream (HLS): for a video player or app, not a browser tab (only Safari opens it)</span>
                    {copyRow(src, 'Stream address')}
                  </div>
                  {signed && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                      <p className="text-sm text-muted-foreground">Your server signs links for each viewer. To share it with someone now, make one here.</p>
                      <Button size="sm" variant="outline" disabled={!playable} onClick={() => setSigning(true)}>Make a signed link</Button>
                      <SignedLinkDialog asset={asset} open={signing} onOpenChange={setSigning} />
                    </div>
                  )}
              </Section>
            {playable && (
              <Section title="Use it in your app" description="Easiest: paste the first snippet into your page. The others are for developers: the video is sent in small pieces (the HLS format), which Safari and iOS play on their own, other browsers with the free hls.js library and Android with ExoPlayer." bodyClassName="grid gap-3">
                    <Code
                      label="Simplest: embed our player"
                      code={embedOf(asset)}
                    />
                    {asset.playback_policy === 'public' ? (
                      <p className={small}>
                        <a href={asset.embed_url} target="_blank" rel="noopener" className="text-primary">
                          Open the player
                        </a>{' '}
                        to see it as viewers do.
                      </p>
                    ) : (
                      <p className={small}>
                        To show who a copy was made for, sign the address with <code>wm</code> (like the viewer's email): the player writes it over the video, and it can't be edited without breaking the signature.
                      </p>
                    )}
                    <Collapsible className="grid gap-3">
                      <CollapsibleTrigger render={<Button variant="link" size="sm" className="justify-self-start px-0" />}>
                          Advanced: for developers
                        </CollapsibleTrigger>
                      <CollapsiblePanel className="grid gap-3">
                    <Code
                      label="Web page (hls.js)"
                      code={`<video id="player" controls playsinline></video>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
  <script>
    const video = document.getElementById('player');
    const src = '${src}';
    if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = src; // Safari, iOS
    else { const hls = new Hls(); hls.loadSource(src); hls.attachMedia(video); }
  </script>`}
                    />
                    {asset.playback_policy === 'signed' && (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Private videos play only from addresses your server signs with a{' '}
                          <AppLink href="/videos/signing-keys" className="text-primary">
                            signing key
                          </AppLink>
                          . Never put the key in the page.
                        </p>
                        <Code
                          label="Your server (Node.js)"
                          code={`import { createHmac } from 'node:crypto';

  // From Video → Signing keys: the key's id and its secret (base64).
  const kid = 'YOUR_KEY_ID', secret = Buffer.from('YOUR_KEY_SECRET', 'base64');
  const video = '${asset.embed_url.replace(/^.*(\/[^/]+\/[^/]+)$/, '$1')}';  // /library/video
  const exp = Math.floor(Date.now() / 1000) + 3600;     // an hour from now
  const signed = \`exp=\${exp}~acl=\${encodeURIComponent(video + '/*')}~kid=\${kid}\`;
  const signature = signed + '~hmac=' + createHmac('sha256', secret).update(signed).digest('hex');
  const token = '?token=' + encodeURIComponent(signature);
  const page = '${asset.embed_url}' + token;                  // for the iframe
  const stream = '${asset.embed_url}/playlist.m3u8' + token;  // for your own player`}
                        />
                      </>
                    )}
                      </CollapsiblePanel>
                    </Collapsible>
                </Section>
              )}
            <TimelinePictures asset={asset} at={preview?.at} signed={signed} />
            <Section
              title="MP4 download"
              description="A single video file people can save to their device. Turn it on only if viewers need to keep the video; it uses extra storage, about the size of one more copy."
              bodyClassName="grid gap-3 text-sm"
              action={!asset.download ? (
                    <Button disabled={busy || asset.status === 'errored'} onClick={makeDownload}>Make an MP4 download</Button>
                  ) : asset.download === 'failed' ? (
                    <Button disabled={busy} onClick={makeDownload}><RefreshCw />Try again</Button>
                  ) : asset.download !== 'preparing' ? (
                    <>
                      {asset.playback_policy === 'public' && <Button render={<a href={`${asset.embed_url}/download.mp4`} />}><Download />Download</Button>}
                      <Menu>
                        <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="Actions for the download" disabled={busy} />}>
                          <Ellipsis />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem variant="destructive" onClick={() => void act(() => api('DELETE', `/v1/assets/${asset.id}/download`)).then((ok) => ok && toast('The download was removed.'))}>
                            <Trash2 />
                            Remove download
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </>
                  ) : null}
            >
                {!asset.download ? (
                  <p className="text-muted-foreground">Off. Viewers can only stream this video.</p>
                ) : asset.download === 'preparing' ? (
                  <p className="flex items-center gap-2">
                    <StatusBadge variant="secondary">Preparing</StatusBadge> {asset.status === 'complete' ? "We're making it now; this usually takes under a minute." : "We'll make it as soon as processing finishes."}
                  </p>
                ) : asset.download === 'failed' ? (
                  <p className="flex items-center gap-2">
                    <StatusBadge variant="destructive">Failed</StatusBadge> We couldn't make the download. Try again; playback isn't affected.
                  </p>
                ) : (
                  <>
                    <p className="flex items-center gap-2">
                      <StatusBadge>Ready</StatusBadge>
                    </p>
                    {copyRow(signed ? signedLink(`${asset.embed_url}/download.mp4`) : `${asset.embed_url}/download.mp4`, 'Download address')}
                    {asset.playback_policy === 'signed' && <p className="text-muted-foreground">This video is private, so the download needs a signature too, made the same way as for playback.</p>}
                  </>
                )}
            </Section>
          </>
        )}


      </div>

      <FormDialog open={addingCaptions} onOpenChange={setAddingCaptions} busy={busy} title="Add captions" description="A subtitle file ending in .vtt or .srt, up to 1 MB. Add one per language.">
        <Wizard
          steps={[['File', 'The caption file (WebVTT or SRT).'], ['Language and name', 'What viewers see in the captions menu.']]}
          step={captionStep}
          busy={busy}
          finish="Add captions"
          onBack={() => setCaptionStep(0)}
          onNext={() => {
            if (captionStep === 1) return void addCaptions()
            const bad = !captionFile
            setCaptionProblems(bad ? { file: say('invalid_captions') } : {})
            if (!bad) setCaptionStep(1)
          }}
        >
          {captionStep === 0 ? (
            <Field invalid={!!captionProblems.file}>
              <FieldLabel htmlFor="caption-file">Caption file</FieldLabel>
              <Input id="caption-file" type="file" accept=".vtt,.srt,text/vtt" onChange={(e) => setCaptionFile(e.currentTarget.files?.[0] ?? null)} aria-invalid={!!captionProblems.file || undefined} />
              {captionProblems.file && <FieldError>{captionProblems.file}</FieldError>}
            </Field>
          ) : (
            <>
              <Field invalid={!!captionProblems.language}>
                <FieldLabel htmlFor="caption-language">Language</FieldLabel>
                <Input id="caption-language" value={captionLanguage} onChange={(e) => setCaptionLanguage(e.target.value)} placeholder="en" aria-invalid={!!captionProblems.language || undefined} />
                <FieldDescription>A short language code, like en for English, bn for Bangla or pt-BR for Brazilian Portuguese.</FieldDescription>
                {captionProblems.language && <FieldError>{captionProblems.language}</FieldError>}
              </Field>
              <Field invalid={!!captionProblems.name}>
                <FieldLabel htmlFor="caption-name">Name</FieldLabel>
                <Input id="caption-name" value={captionName} onChange={(e) => setCaptionName(e.target.value)} placeholder="English" aria-invalid={!!captionProblems.name || undefined} />
                <FieldDescription>What viewers see in the player's captions menu.</FieldDescription>
                {captionProblems.name && <FieldError>{captionProblems.name}</FieldError>}
              </Field>
            </>
          )}
        </Wizard>
      </FormDialog>
    </div>
  )
}

/** What the server did with the video: its source, how it was encoded, the work it took and what is stored. */
function TechnicalTab({ asset }: { asset: string }) {
  const q = useGet<Tech>(`/v1/assets/${asset}/technical`)
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Skeleton className="h-48 w-full" />
  return (
    <>
      <Technical tech={q.data} show="source" />
      <Technical tech={q.data} show="encoding" />
      <Technical tech={q.data} show="pipeline" />
      <Technical tech={q.data} show="storage" />
    </>
  )
}
