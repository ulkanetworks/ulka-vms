import type { ReactNode } from 'react'
import { CircleCheck, TriangleAlert } from '@/components/icons'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'

export type Phase = 'working' | 'done' | 'failed'

/** One look for every slow thing: what is happening in plain words, roughly how long, and (when it failed) what to do.
 *  `working` spins, `done` is shown only once it is really done, `failed` offers its `action` (a Try again button). */
export function Working({ phase, title, children, action }: { phase: Phase; title: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = phase === 'working' ? Spinner : phase === 'done' ? CircleCheck : TriangleAlert
  return (
    <Alert variant={phase === 'working' ? 'info' : phase === 'done' ? 'success' : 'error'} role="status" aria-live="polite">
      <Icon aria-label="" />
      <AlertTitle>{title}</AlertTitle>
      {children && <AlertDescription>{children}</AlertDescription>}
      {action && <AlertAction>{action}</AlertAction>}
    </Alert>
  )
}
