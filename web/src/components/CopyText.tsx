import type { ReactNode } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { cn } from '@/lib/utils'

/** A value people copy (an address, a domain, an ID) in the mono face with a small copy button after it. */
export function CopyText({ value, what, className, children, wrap }: { value: string; what: string; className?: string; children?: ReactNode; wrap?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 align-middle">
      <span className={cn('min-w-0 font-mono', wrap ? 'break-all' : 'truncate', className)}>{children ?? value}</span>
      <CopyButton value={value} what={what} />
    </span>
  )
}
