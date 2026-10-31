import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { compact, number, size } from '@/lib/format'

/** A count or a size, the way YouTube writes them: counts in full below 10,000, then short (12K, 1.3M) with the
 *  exact count on hover; sizes as people read them (4.1 MB), with nothing to hover. */
export function Figure({ n, kind = 'count', unit }: { n: number; kind?: 'count' | 'bytes'; unit?: string }) {
  const tail = unit ? ` ${unit}` : ''
  if (kind === 'bytes') return <>{size(n) + tail}</>
  if (Math.abs(n) < 10_000) return <>{number(n) + tail}</>
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default" />}>{compact(n) + tail}</TooltipTrigger>
      <TooltipPopup>{number(n) + tail}</TooltipPopup>
    </Tooltip>
  )
}
