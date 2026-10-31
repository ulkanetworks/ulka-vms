import { useState, type ReactElement, type ReactNode } from 'react'
import { Check, ChevronDown, Globe, Lock } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Code } from '@/components/Code'
import { CopyButton } from '@/components/CopyButton'
import type { Asset, Policy } from '@/lib/api'
import { cn } from '@/lib/utils'

export const PRIVACY: Record<Policy, { label: string; help: string; icon: typeof Globe }> = {
  signed: { label: 'Private', help: 'Only people with a signed link can watch', icon: Lock },
  public: { label: 'Public', help: 'Anyone with the link can watch', icon: Globe },
}

/** The small badge on a video: a globe and Public, or a lock and Private. */
export function PrivacyBadge({ policy, className }: { policy: Policy; className?: string }) {
  const { label, icon: Icon } = PRIVACY[policy]
  return (
    <Badge variant="outline" className={cn('gap-1', className)}>
      <Icon className="size-3" />
      {label}
    </Badge>
  )
}

// What a switch does for viewers, said before it happens.
const CONFIRM: Record<Policy, { title: string; body: string; action: string }> = {
  public: { title: 'Make this video public?', body: 'Anyone with its address can watch, without a signed link. Signed links made earlier keep working.', action: 'Make public' },
  signed: { title: 'Make this video private?', body: 'It plays only with a signed link from then on. Pages that show its plain address stop playing it at once.', action: 'Make private' },
}

/** A menu of the two choices, each with its icon, a one-line promise and a tick on the current one. With `confirm`
 *  (an existing video, where viewers notice at once) a choice asks first. */
export function PrivacyMenu({ value, onChange, disabled, label = 'Privacy', confirm = false }: { value: Policy; onChange: (p: Policy) => void; disabled?: boolean; label?: string; confirm?: boolean }) {
  const [asking, setAsking] = useState<Policy | null>(null)
  const Icon = PRIVACY[value].icon
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button variant="outline" size="sm" disabled={disabled} aria-label={label} className="justify-between" />}>
          <span className="flex items-center gap-2">
            <Icon />
            {PRIVACY[value].label}
          </span>
          <ChevronDown />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-72">
          {(['signed', 'public'] as const).map((p) => {
            const { label: name, help, icon: Glyph } = PRIVACY[p]
            return (
              <MenuItem key={p} className="items-start gap-3 py-2" onClick={() => p !== value && (confirm ? setAsking(p) : onChange(p))}>
                <Glyph className="mt-0.5" />
                <span className="grid flex-1 gap-0.5">
                  <span className="font-medium">{name}</span>
                  <span className="text-xs text-muted-foreground">{help}</span>
                </span>
                {p === value && <Check className="mt-0.5" aria-label="Current" />}
              </MenuItem>
            )
          })}
        </MenuPopup>
      </Menu>
      <AlertDialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <AlertDialogPopup>
          {asking && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{CONFIRM[asking].title}</AlertDialogTitle>
                <AlertDialogDescription>{CONFIRM[asking].body} Its address stays the same.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>Keep it {PRIVACY[value].label.toLowerCase()}</AlertDialogClose>
                <AlertDialogClose render={<Button onClick={() => onChange(asking)} />}>{CONFIRM[asking].action}</AlertDialogClose>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogPopup>
      </AlertDialog>
    </>
  )
}

type Shared = Pick<Asset, 'id' | 'playback_policy' | 'embed_url'>

/** A private video's address, showing where the signature from the customer's server goes. */
export const signedLink = (address: string) => `${address}?token=SIGNATURE_FROM_YOUR_SERVER`

export const embedOf = (a: Shared) =>
  `<iframe src="${a.playback_policy === 'signed' ? signedLink(a.embed_url) : a.embed_url}"\n    style="width: 100%; aspect-ratio: 16 / 9; border: 0"\n    allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`

/** The link and embed code of a video, shown in full in a dialog to read and copy; a private one says what its link needs. */
export function ShareDialog({ asset, trigger, children }: { asset: Shared; trigger: ReactElement; children: ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger render={trigger}>{children}</DialogTrigger>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Share this video</DialogTitle>
          <DialogDescription>
            {asset.playback_policy === 'public'
              ? 'Anyone with the link can watch. Send the link, or put the player on your own page with the embed code.'
              : 'It is private: your server signs each link, so there is no plain link to send. The embed code shows where the signature goes.'}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          {asset.playback_policy === 'public' && (
            <Field>
              <FieldLabel htmlFor={`link-${asset.id}`}>Link</FieldLabel>
              <InputGroup>
                <InputGroupInput id={`link-${asset.id}`} readOnly value={asset.embed_url} className="font-mono" onFocus={(e) => e.target.select()} />
                <InputGroupAddon align="inline-end">
                  <CopyButton value={asset.embed_url} what="Link" />
                </InputGroupAddon>
              </InputGroup>
            </Field>
          )}
          <Code label="Embed code" lang="html" code={embedOf(asset)} wrap />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
