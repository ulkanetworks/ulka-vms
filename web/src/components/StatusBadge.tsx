import type { ComponentProps } from 'react'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

export type Tone = 'success' | 'danger' | 'warning' | 'accent' | 'primary' | 'neutral'
type Legacy = 'default' | 'destructive' | 'secondary' | 'outline'

const DOT: Record<Tone, string> = {
  success: 'bg-emerald-500',
  danger: 'bg-red-500',
  warning: 'bg-amber-500',
  accent: 'bg-blue-500',
  primary: 'bg-primary',
  neutral: 'bg-muted-foreground/64',
}
const OF_VARIANT: Record<Legacy, Tone> = { default: 'success', destructive: 'danger', secondary: 'neutral', outline: 'neutral' }

/** A state as an outlined badge with a coloured dot: green is good, red is trouble, amber is waiting, grey is neutral.
 * `busy` turns the dot into a spinner, for a state where work is under way (setting up, deleting). */
export function StatusBadge({ tone, variant, busy, className, children, ...props }: Omit<ComponentProps<typeof Badge>, 'variant'> & { tone?: Tone | string; variant?: Legacy | string | null; busy?: boolean }) {
  const v = (variant ?? 'default') as string
  const t = (tone ?? (v in DOT ? v : OF_VARIANT[v as Legacy]) ?? 'neutral') as Tone
  return (
    <Badge variant="outline" className={cn('font-sans', className)} {...props}>
      {busy ? <Spinner aria-hidden="true" role={undefined} className="size-3 text-amber-500" /> : <span aria-hidden="true" className={cn('size-1.5 rounded-full', DOT[t] ?? DOT.neutral)} />}
      {children}
    </Badge>
  )
}
