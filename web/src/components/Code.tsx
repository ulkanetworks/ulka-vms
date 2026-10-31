import { useMemo, useState } from 'react'
import { WrapText } from '@/components/icons'
import { Toggle } from '@/components/ui/toggle'
import { highlight } from '@/lib/code-highlight'
import { CopyButton } from '@/components/CopyButton'
import { cn } from '@/lib/utils'

// A multi-line example to copy into an app or terminal.
/** wrap: start with long lines wrapped instead of scrolling; the toggle beside Copy switches it. */
export function Code({ code, label, lang, wrap }: { code: string; label?: string; lang?: string; wrap?: boolean }) {
  const html = useMemo(() => highlight(code, lang), [code, lang])
  const [wrapped, setWrapped] = useState(!!wrap)
  return (
    <div className="overflow-hidden rounded-lg bg-muted ring-1 ring-border">
      <div className="flex items-center justify-between border-b border-border py-0.5 pr-2 pl-3 text-xs font-semibold text-muted-foreground">
        <span>{label ?? ''}</span>
        <span className="flex items-center gap-0.5">
          <Toggle size="sm" pressed={wrapped} onPressedChange={setWrapped} aria-label="Wrap long lines" title="Wrap long lines" className="text-muted-foreground">
            <WrapText />
          </Toggle>
          <CopyButton value={code} what={label ?? 'code'} />
        </span>
      </div>
      <div
        className={cn(wrapped && "[&_pre]:break-all [&_pre]:whitespace-pre-wrap", "[&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:px-4 [&_pre]:pt-3 [&_pre]:pb-4 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:leading-[1.7] [&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0")}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
