import { useState, type ComponentProps } from 'react'
import { AppLink } from '@/components/AppLink'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { api, type Group, type Library } from '@/lib/api'
import { message } from '@/lib/messages'
import { refresh } from '@/lib/query'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

const WHAT: Record<Group, string> = { player: 'player look', transcoding: 'video quality and MP4 setting', security: 'security settings' }

/** For a library section: whether its fields are locked (following the workspace defaults) and the bar that says so. No library means the defaults page: never locked. */
export function useInherit(lib: Library | undefined, group: Group) {
  const [unlocked, setUnlocked] = useState(false)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!lib) return { locked: false, bar: null }
  const follows = lib.inherits.includes(group)

  async function reset() {
    setBusy(true)
    try {
      await api('PATCH', `/v1/libraries/${lib!.id}`, { inherit: { [group]: true } })
      await refresh('/v1/libraries')
      setUnlocked(false)
      setAsking(false)
      toast('This library now uses your workspace defaults.')
    } catch (err) {
      toast(message(err), 'danger')
    }
    setBusy(false)
  }

  const bar = (
    <Alert className="mb-4 max-w-2xl">
      <AlertTitle>{follows ? 'Using your workspace defaults' : 'Customized for this library'}</AlertTitle>
      <AlertDescription>
        {follows
          ? unlocked
            ? 'Save to set this library on its own. Until then it keeps following the defaults.'
            : 'When you change the defaults, this library changes with them. Customize it to set its own.'
          : 'This library has its own settings and no longer follows the defaults.'}
      </AlertDescription>
      <AlertAction>
        {follows ? (
          <>
            {!unlocked && <Button size="sm" onClick={() => setUnlocked(true)}>Customize</Button>}
            <Button size="sm" variant="ghost" render={<AppLink href={`/videos/defaults?tab=${group}`} />}>Workspace defaults</Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setAsking(true)}>Use workspace defaults</Button>
        )}
      </AlertAction>
      <AlertDialog open={asking} onOpenChange={(o) => !busy && setAsking(o)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Use your workspace defaults?</AlertDialogTitle>
            <AlertDialogDescription>This library’s own {WHAT[group]} will be replaced by your workspace defaults. This can’t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />} disabled={busy}>Keep my settings</AlertDialogClose>
            <Button disabled={busy} onClick={() => void reset()}>Use workspace defaults</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Alert>
  )
  return { locked: follows && !unlocked, bar }
}

/** Fields that can't be changed while locked. */
export function Lock({ locked, className, ...rest }: { locked: boolean } & ComponentProps<'fieldset'>) {
  return <fieldset disabled={locked} className={cn('min-w-0', locked && 'opacity-60', className)} {...rest} />
}
