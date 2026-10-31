import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, CircleCheck, FileVideo, RefreshCw, Share, X } from '@/components/icons'
import { AppLink } from '@/components/AppLink'
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress'
import { ShareDialog, PrivacyMenu } from '@/components/library/Privacy'
import { number, remaining, share, size } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cancelAll, cancelUpload, clearUploads, removeUpload, retryUpload, setUploadsPolicy, uploads, type Upload } from '@/lib/uploads'

// Minimised or open is remembered while the app is open, not between visits.
let minimised = false

function Row({ u }: { u: Upload }) {
  const live = u.state === 'starting' || u.state === 'uploading'
  const pending = live || u.state === 'waiting'
  const left = u.speed > 0 ? ` · ${remaining((u.size - u.sent) / u.speed)} left` : ''
  return (
    <li className="grid gap-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <FileVideo className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-medium" title={u.name}>
            {u.name}
          </span>
          {pending && (
            <span className="truncate text-xs text-muted-foreground tabular-nums">
              {u.state === 'waiting' ? `${size(u.size)} · waiting` : u.state === 'starting' ? `${size(u.size)} · starting` : `${size(u.sent)} / ${size(u.size)} · ${share(u.sent, u.size)}${left}`}
            </span>
          )}
          {u.state === 'done' && <span className="truncate text-xs text-muted-foreground tabular-nums">{size(u.size)} · uploaded, now processing</span>}
          {u.state === 'cancelled' && <span className="text-xs text-muted-foreground">Cancelled.</span>}
          {u.state === 'failed' && (
            <span className="line-clamp-2 text-xs text-destructive-foreground" title={u.problem}>
              {u.problem}
            </span>
          )}
        </div>
        {u.state === 'done' && (
          <>
            <CircleCheck aria-label="Uploaded" className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            {u.link && (
              <ShareDialog asset={u.link} trigger={<Button size="xs" variant="outline" aria-label={`Share ${u.name}`} />}>
                <Share />
                Share
              </ShareDialog>
            )}
            <Button size="xs" variant="ghost" render={<AppLink href={`/videos/library/${u.libraryId}${u.assetId ? `?video=${u.assetId}` : ''}`} />}>
              Open
            </Button>
          </>
        )}
        {(u.state === 'failed' || u.state === 'cancelled') && (
          <Button size="xs" variant="outline" onClick={() => retryUpload(u.key)}>
            <RefreshCw />
            Try again
          </Button>
        )}
        {pending ? (
          <Button size="icon-xs" variant="ghost" aria-label={`Cancel ${u.name}`} onClick={() => cancelUpload(u.key)}>
            <X />
          </Button>
        ) : (
          <Button size="icon-xs" variant="ghost" aria-label={`Remove ${u.name} from the list`} onClick={() => removeUpload(u.key)}>
            <X />
          </Button>
        )}
      </div>
      {pending && (
        <Progress value={u.size ? (u.sent / u.size) * 100 : 0} aria-label={`${u.name} uploaded`}>
          <ProgressTrack>
            <ProgressIndicator className="motion-reduce:transition-none" />
          </ProgressTrack>
        </Progress>
      )}
    </li>
  )
}

/** Every upload in one place at the bottom right, so they carry on while you move around the console. */
export function UploadDock() {
  const list = uploads.use()
  const [open, setOpen] = useState(!minimised)
  const [asking, setAsking] = useState(false)
  const active = list.filter((u) => u.state === 'waiting' || u.state === 'starting' || u.state === 'uploading').length
  const done = list.filter((u) => u.state === 'done').length
  const failed = list.filter((u) => u.state === 'failed').length
  const places = new Set(list.map((u) => (u.folder ? `${u.library} / ${u.folder}` : u.library)))
  const total = list.reduce((n, u) => n + u.size, 0)
  const sent = list.reduce((n, u) => n + (u.state === 'done' ? u.size : u.sent), 0)

  // Leaving the page would stop the files that are still going.
  useEffect(() => {
    if (!active) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active])

  if (!list.length) return null
  const toggle = () => ((minimised = open), setOpen(!open))
  const title = active ? `Uploading ${number(done)} of ${number(list.length)}` : done === list.length ? (list.length === 1 ? 'Uploaded' : `All ${number(list.length)} uploaded`) : `${number(done)} of ${number(list.length)} uploaded${failed ? `, ${number(failed)} failed` : ''}`
  const Chevron = open ? ChevronDown : ChevronUp

  return (
    <section aria-label="Uploads" className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg/10 sm:left-auto sm:w-96">
      <header className="flex items-center gap-1 border-b px-3 py-1.5">
        <div className="grid min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium" aria-live="polite">
            {title}
          </h2>
          <p className="truncate text-xs text-muted-foreground">{places.size === 1 ? `Location: ${[...places][0]}` : `Location: ${number(places.size)} places`}</p>
        </div>
        <Button size="icon-xs" variant="ghost" aria-label={open ? 'Minimise uploads' : 'Show uploads'} aria-expanded={open} onClick={toggle}>
          <Chevron />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close uploads" onClick={() => (active ? setAsking(true) : clearUploads())}>
          <X />
        </Button>
      </header>
      {active > 0 && (
        <Progress value={total ? (sent / total) * 100 : 0} aria-label="All uploads" className="gap-0">
          <ProgressTrack className="h-0.5 rounded-none">
            <ProgressIndicator className="motion-reduce:transition-none" />
          </ProgressTrack>
        </Progress>
      )}
      {open && (
        <>
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <span className="text-xs text-muted-foreground">Who can watch</span>
            <PrivacyMenu
              label="Who can watch these uploads"
              value={list.at(-1)!.policy}
              onChange={(p) => void setUploadsPolicy(p).then((ok) => !ok && toast("Some videos could not be changed. Try again.", 'danger'))}
            />
          </div>
          <ul className="max-h-72 divide-y overflow-y-auto">
            {list.map((u) => (
              <Row key={u.key} u={u} />
            ))}
          </ul>
          {!active && done === list.length && (
            <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
              <p className="text-xs text-muted-foreground">{list.length === 1 ? 'Uploaded.' : `All ${number(list.length)} uploaded.`} They will be playable in a few minutes.</p>
              <Button size="xs" variant="outline" onClick={clearUploads}>
                Clear
              </Button>
            </div>
          )}
        </>
      )}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop uploading?</AlertDialogTitle>
            <AlertDialogDescription>{number(active)} {active === 1 ? 'file is' : 'files are'} still going. Closing stops {active === 1 ? 'it' : 'them'} and removes the unfinished videos.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep uploading</AlertDialogClose>
            <Button variant="destructive" onClick={() => (cancelAll(), clearUploads(), setAsking(false))}>
              Stop and close
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  )
}
