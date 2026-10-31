import { useEffect, useState, type ReactNode } from 'react'
import { Check, Ellipsis, Plus, Trash2 } from '@/components/icons'
import { LoadError } from '@/components/LoadError'
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/Section'
import { Checkbox } from '@/components/ui/checkbox'
import { Menu, MenuPopup, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { FormDialog, Wizard } from '@/components/Wizard'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, type Library, type Preset, type Quality, type Template, type Transcoding, type VideoDefaults } from '@/lib/api'
import { Lock, useInherit } from '@/components/library/Inherit'
import { message } from '@/lib/messages'
import { refresh, useGet } from '@/lib/query'
import { StatusBadge } from '@/components/StatusBadge'
import { toast } from '@/lib/toast'

const SIZES = [
  { h: 1080, hint: 'Full HD, for big screens' },
  { h: 720, hint: 'HD, the usual choice' },
  { h: 480, hint: 'Standard, good on phones' },
  { h: 360, hint: 'Light, for slow connections' },
  { h: 240, hint: 'Tiny, the lowest data use' },
]
const QUALITIES: { id: Quality; label: string; text: string }[] = [
  { id: 'fast', label: 'Fastest', text: 'Ready soonest. A little softer or larger.' },
  { id: 'balanced', label: 'Balanced', text: 'Sharp at a sensible size. Our usual choice.' },
  { id: 'high', label: 'Sharpest', text: 'A sharper picture with larger files. Takes about twice as long.' },
]
const qualityName = (q: Quality) => QUALITIES.find((x) => x.id === q)?.label ?? q
const qualityText = (q: Quality) => QUALITIES.find((x) => x.id === q)?.text ?? ''
const sizes = (heights: number[]) => [...heights].sort((a, b) => b - a)

function Sizes({ heights }: { heights: number[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {sizes(heights).map((h) => (
        <Badge key={h} variant="outline" className="tabular-nums">
          {h}p
        </Badge>
      ))}
    </span>
  )
}

const GroupRow = ({ label }: { label: string }) => (
  <TableRow className="bg-muted/32 hover:bg-muted/32">
    <TableCell colSpan={4} className="py-1.5 text-xs font-medium text-muted-foreground">
      {label}
    </TableCell>
  </TableRow>
)

// One preset as a table row; its buttons go in the last cell.
function PresetRow({ name, description, heights, quality, yours, children }: { name: string; description?: string; heights: number[]; quality: Quality; yours?: boolean; children: ReactNode }) {
  return (
    <TableRow>
      <TableCell className="min-w-56 whitespace-normal">
        <div className="flex items-center gap-2 font-medium">
          <span className="truncate">{name}</span>
          {yours && <Badge variant="secondary">Yours</Badge>}
        </div>
        {description && <div className="mt-1 text-xs leading-snug text-muted-foreground">{description}</div>}
      </TableCell>
      <TableCell>
        <Sizes heights={heights} />
        <span className="text-xs text-muted-foreground md:hidden">{qualityName(quality)} quality</span>
      </TableCell>
      <TableCell className="hidden min-w-48 whitespace-normal md:table-cell">
        {qualityName(quality)}
        <div className="mt-1 text-xs leading-snug text-muted-foreground">{qualityText(quality)}</div>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">{children}</div>
      </TableCell>
    </TableRow>
  )
}

function UseButton({ inUse, busy, id, onUse }: { inUse: boolean; busy: string; id: string; onUse: () => void }) {
  return inUse ? (
    <StatusBadge>
      <Check className="size-3" />
      In use
    </StatusBadge>
  ) : (
    <Button size="sm" disabled={!!busy} onClick={onUse}>
      {busy === id && <Spinner />}
      Use this
    </Button>
  )
}

type Draft = { id?: string; name: string; description: string; heights: number[]; quality: Quality }
const blank: Draft = { name: '', description: '', heights: [1080, 720, 480, 360], quality: 'balanced' }

const DEFAULTS = '/v1/video/defaults'

// Without a library this edits the workspace defaults: ready-made presets only, no custom ones.
export function TranscodingTab({ lib }: { lib?: Library }) {
  const defaults = useGet<VideoDefaults>(lib ? null : DEFAULTS)
  const { locked, bar } = useInherit(lib, 'transcoding')
  const now = lib ?? defaults.data
  if (!lib && defaults.error) return <LoadError error={defaults.error} retry={defaults.refetch} />
  if (!now) return <Skeleton className="h-96 w-full" />
  return (
    <>
      {bar}
      <TranscodingEditor key={`${now.preset_template}${now.mp4_downloads}`} lib={lib} template={now.preset_template} mp4On={now.mp4_downloads} locked={locked} />
    </>
  )
}

function TranscodingEditor({ lib, template, mp4On, locked }: { lib?: Library; template: string; mp4On: boolean; locked: boolean }) {
  // The ready-made presets are the same for everyone; the defaults page reads them from the main library.
  const libs = useGet<{ data: Library[] }>(lib ? null : '/v1/libraries?limit=100')
  const via = lib ?? libs.data?.data.find((l) => l.is_default) ?? libs.data?.data[0]
  const path = via ? `/v1/libraries/${via.id}/transcoding` : null
  const q = useGet<Transcoding>(path)
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [problem, setProblem] = useState('')
  const [pStep, setPStep] = useState(0)
  const editing = !!draft
  useEffect(() => {
    if (editing) setPStep(0)
  }, [editing])
  const [removing, setRemoving] = useState<Preset | null>(null)
  const [mp4, setMp4] = useState(mp4On)

  if (q.error) return <LoadError error={q.error} retry={q.refetch} />
  if (!q.data) return <Skeleton className="h-96 w-full" />
  const t = q.data
  const activePreset = lib ? t.active_preset : null
  const activeTemplate = lib ? t.active_template : template
  const active = activePreset ? t.presets.find((p) => p.id === activePreset) : undefined
  const current = active ?? t.templates.find((x) => x.key === activeTemplate)
  const NOTE = 'Saved. It applies to every library that follows the workspace defaults.'

  async function act(key: string, run: () => Promise<unknown>, done: string) {
    setBusy(key)
    try {
      await run()
      await Promise.all([refresh('/v1/libraries'), refresh(DEFAULTS), path ? refresh(path) : null])
      toast(done)
      return true
    } catch (err) {
      toast(message(err), 'danger')
      return false
    } finally {
      setBusy('')
    }
  }
  const chooseTemplate = (x: Template) =>
    lib ? act(x.key, () => api('PUT', `/v1/libraries/${lib.id}/transcoding`, { template: x.key }), `New videos will use ${x.name}.`) : act(x.key, () => api('PUT', DEFAULTS, { preset_template: x.key }), NOTE)
  const choosePreset = (p: Preset) => act(p.id, () => api('PUT', `/v1/libraries/${lib!.id}/transcoding`, { preset_id: p.id }), `New videos will use ${p.name}.`)

  async function save() {
    if (!draft) return
    const name = draft.name.trim()
    if (!name || name.length > 80) return setProblem('Name the preset in 1 to 80 characters.')
    if (!draft.heights.length) return setProblem('Pick at least one size.')
    setProblem('')
    const body = { name, description: draft.description.trim(), heights: draft.heights, quality: draft.quality }
    const ok = await act('save', () => (draft.id ? api('PATCH', `/v1/presets/${draft.id}`, body) : api('POST', `/v1/libraries/${lib!.id}/presets`, body)), draft.id ? 'Preset saved.' : 'Preset created.')
    if (ok) setDraft(null)
  }

  return (
    <div className="grid min-w-0 gap-6">
      <Lock locked={locked} className="grid min-w-0 gap-6">
      <Section
        title={
          <>
            <span className="w-full text-sm font-normal text-muted-foreground">{lib ? 'New videos in this library are prepared with' : 'New videos in libraries that follow the defaults are prepared with'}</span>
            {current?.name ?? 'Balanced'}
            {current && <Sizes heights={current.heights} />}
            {current && <span className="text-sm font-normal text-muted-foreground">{qualityName(current.quality)} quality</span>}
          </>
        }
        description="It applies to videos uploaded from now on. Videos you already have keep how they were made. Every video is encrypted."
      />

      <Section
        bare
        className="min-w-0"
        title="Presets"
        description="Pick how new videos are prepared."
        action={
          lib && (
            <Button size="sm" onClick={() => (setProblem(''), setDraft(blank))}>
              <Plus />
              New preset
            </Button>
          )
        }
      >
        <Table variant="card">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Qualities</TableHead>
              <TableHead className="hidden md:table-cell">Picture quality</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Action</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lib && <GroupRow label="Ready-made" />}
            {t.templates.map((x) => {
              const inUse = !activePreset && activeTemplate === x.key
              return (
                <PresetRow key={x.key} name={x.name} description={x.description} heights={x.heights} quality={x.quality}>
                  {lib && (
                    <Button size="sm" variant="ghost" onClick={() => (setProblem(''), setDraft({ name: `${x.name} copy`, description: '', heights: x.heights, quality: x.quality }))}>
                      Customize
                    </Button>
                  )}
                  <UseButton inUse={inUse} busy={busy} id={x.key} onUse={() => void chooseTemplate(x)} />
                </PresetRow>
              )
            })}
            {lib && <GroupRow label="Yours" />}
            {lib && t.presets.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="whitespace-normal text-muted-foreground">
                  Presets you make for this library appear here. Start from a ready-made one with Customize, or make one from scratch.
                </TableCell>
              </TableRow>
            )}
            {lib &&
              t.presets.map((p) => {
                const inUse = activePreset === p.id
                return (
                  <PresetRow key={p.id} name={p.name} description={p.description} heights={p.heights} quality={p.quality} yours>
                    <UseButton inUse={inUse} busy={busy} id={p.id} onUse={() => void choosePreset(p)} />
                    <Menu>
                      <MenuTrigger render={<Button size="icon" variant="ghost" aria-label={`Actions for ${p.name}`} />}>
                        <Ellipsis />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => (setProblem(''), setDraft({ id: p.id, name: p.name, description: p.description, heights: p.heights, quality: p.quality }))}>Edit</MenuItem>
                        <MenuItem variant="destructive" disabled={inUse} onClick={() => setRemoving(p)}>
                          {inUse ? 'Delete (in use)' : 'Delete'}
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </PresetRow>
                )
              })}
          </TableBody>
        </Table>
      </Section>

      <Section>
          <Field className="flex-row items-start gap-3">
            <div className="flex flex-1 flex-col gap-1">
              <FieldLabel htmlFor="mp4">Make an MP4 download for every new video</FieldLabel>
              <FieldDescription>MP4 is a single file viewers can save. It takes extra storage.</FieldDescription>
            </div>
            <Switch
              id="mp4"
              checked={mp4}
              disabled={busy === 'mp4'}
              onCheckedChange={(on) => {
                setMp4(on)
                void act('mp4', () => (lib ? api('PATCH', `/v1/libraries/${lib.id}`, { mp4_downloads: on }) : api('PUT', DEFAULTS, { mp4_downloads: on })), lib ? (on ? 'MP4 downloads are on for new videos.' : 'MP4 downloads are off.') : NOTE).then((ok) => ok || setMp4(!on))
              }}
            />
          </Field>
      </Section>

      </Lock>

      <FormDialog open={!!draft} onOpenChange={(o) => !o && busy !== 'save' && setDraft(null)} busy={busy === 'save'} title={draft?.id ? 'Edit preset' : 'New preset'} description="Choose the sizes your viewers can pick from and how carefully each is prepared.">
        {draft && (
          <Wizard
            steps={[['Name', 'A name for this preset, and what it is for.'], ['Sizes', 'The video sizes made for each upload.'], ['Quality', 'How sharp each size is, against how big its files are.']]}
            step={pStep}
            busy={busy === 'save'}
            finish={draft.id ? 'Save preset' : 'Create preset'}
            unchanged={(() => {
              const was = draft.id ? t?.presets.find((p) => p.id === draft.id) : undefined
              return !!was && JSON.stringify([was.name, was.description, was.heights, was.quality]) === JSON.stringify([draft.name.trim(), draft.description.trim(), draft.heights, draft.quality])
            })()}
            onBack={() => (setProblem(''), setPStep(pStep - 1))}
            onNext={() => {
              const name = draft.name.trim()
              if (pStep === 0 && (!name || name.length > 80)) return setProblem('Name the preset in 1 to 80 characters.')
              if (pStep === 1 && !draft.heights.length) return setProblem('Pick at least one size.')
              setProblem('')
              if (pStep < 2) setPStep(pStep + 1)
              else void save()
            }}
          >
            {problem && (
              <Alert variant="error">
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            )}
            {pStep === 0 && (
              <>
                <Field>
                  <FieldLabel htmlFor="preset-name">Name</FieldLabel>
                  <Input id="preset-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Lessons" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="preset-desc">What it is for (optional)</FieldLabel>
                  <Textarea id="preset-desc" rows={2} className="[&_textarea]:max-h-40" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </Field>
              </>
            )}
            {pStep === 1 && (
              <Field>
                <FieldLabel>Sizes</FieldLabel>
                {SIZES.map((s) => (
                  <Field key={s.h} className="flex-row items-start gap-3">
                    <Checkbox
                      id={`size-${s.h}`}
                      checked={draft.heights.includes(s.h)}
                      onCheckedChange={(on) => setDraft({ ...draft, heights: on === true ? [...draft.heights, s.h] : draft.heights.filter((x) => x !== s.h) })}
                    />
                    <div className="flex flex-1 flex-col gap-1">
                      <FieldLabel htmlFor={`size-${s.h}`}>{s.h}p</FieldLabel>
                      <FieldDescription>{s.hint}</FieldDescription>
                    </div>
                  </Field>
                ))}
                <FieldDescription>A size taller than the uploaded video is skipped, so nothing is stretched. Each extra size adds storage and preparation time.</FieldDescription>
              </Field>
            )}
            {pStep === 2 && (
              <Field>
                <FieldLabel>Quality</FieldLabel>
                <RadioGroup value={draft.quality} onValueChange={(v) => setDraft({ ...draft, quality: v as Quality })}>
                  {QUALITIES.map((x) => (
                    <Field key={x.id} className="flex-row items-start gap-3">
                      <RadioGroupItem value={x.id} id={`q-${x.id}`} />
                      <div className="flex flex-1 flex-col gap-1">
                        <FieldLabel htmlFor={`q-${x.id}`}>{x.label}</FieldLabel>
                        <FieldDescription>{x.text}</FieldDescription>
                      </div>
                    </Field>
                  ))}
                </RadioGroup>
              </Field>
            )}
          </Wizard>
        )}
      </FormDialog>

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && !busy && setRemoving(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Videos already made with it keep playing. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!!busy}
              onClick={() => {
                if (removing) void act('delete', () => api('DELETE', `/v1/presets/${removing.id}`), 'Preset deleted.').then(() => setRemoving(null))
              }}
            ><Trash2 />
              Delete preset
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  )
}
