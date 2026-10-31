import { useState } from 'react'
import { Folder as FolderIcon, Home } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Select, SelectPopup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import type { Folder, Library } from '@/lib/api'
import { message } from '@/lib/messages'
import { useGet } from '@/lib/query'
import { flatTree } from './FolderTree'

type Props = {
  title: string
  libraryId: string
  /** Offer other libraries too (moving videos); folders can only move within their library. */
  libraries?: Library[]
  /** A folder that can't be picked, nor anything below it. */
  exclude?: string
  onClose: () => void
  onPick: (libraryId: string, folderId: string | null) => Promise<void>
}

type ChoiceProps = { lib: string; onLib: (id: string) => void; dest: string | null; onDest: (id: string | null) => void; libraries?: Library[]; exclude?: string; top?: string }

/** A library (when several are offered) and the folder tree of it to pick one from; null is the top. */
export function FolderChoice({ lib, onLib, dest, onDest, libraries, exclude, top = 'Home' }: ChoiceProps) {
  const folders = useGet<{ data: Folder[] }>(`/v1/libraries/${lib}/folders`)
  const pick = (id: string | null) => (
    <Button key={id ?? 'top'} type="button" variant={dest === id ? 'secondary' : 'ghost'} className="w-full justify-start gap-2" onClick={() => onDest(id)}>
      {id ? <FolderIcon /> : <Home />}
      <span className="truncate">{id ? folders.data?.data.find((f) => f.id === id)?.name : top}</span>
    </Button>
  )
  return (
    <div className="grid content-start gap-3">
      {libraries && libraries.length > 1 && (
        <Select items={libraries.map((l) => ({ label: l.name, value: l.id }))} value={lib} onValueChange={(l) => l && (onLib(l), onDest(null))}>
          <SelectTrigger aria-label="Library">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {libraries.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {folders.error ? (
        <p className="text-sm text-destructive">{message(folders.error)}</p>
      ) : !folders.data ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="grid gap-1">
          {pick(null)}
          {flatTree(folders.data.data, exclude).map(({ folder, depth }) => (
            <div key={folder.id} style={{ paddingLeft: `${(depth + 1) * 1}rem` }}>
              {pick(folder.id)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Pick where to move something: a library and a folder in it (null: Home). */
export function FolderPicker({ title, libraryId, libraries, exclude, onClose, onPick }: Props) {
  const [lib, setLib] = useState(libraryId)
  const [dest, setDest] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  async function go() {
    setBusy(true)
    setProblem('')
    try {
      await onPick(lib, dest)
      onClose()
    } catch (err) {
      setProblem(message(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Choose where it goes.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <FolderChoice lib={lib} onLib={setLib} dest={dest} onDest={setDest} libraries={libraries} exclude={exclude} />
          {problem && <p className="mt-3 text-sm text-destructive">{problem}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void go()}>
            {busy && <Spinner />}
            Move here
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
