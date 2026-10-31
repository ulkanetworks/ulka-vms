import { useState } from 'react'
import { Video } from '@/components/icons'
import type { Asset } from '@/lib/api'
import { cn } from '@/lib/utils'
import { posterOf } from './VideoCard'

/** A video's thumbnail in lists; the camera placeholder until it has one, or if it can't load. */
export function VideoThumb({ asset, width, className, icon = 'size-4' }: { asset: Asset; width: number; className?: string; icon?: string }) {
  const src = posterOf(asset, width)
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) {
    return (
      <span className={cn('grid aspect-video place-items-center bg-muted text-muted-foreground', className)}>
        <Video className={icon} />
      </span>
    )
  }
  return <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(src)} className={cn('aspect-video bg-muted object-cover', className)} />
}
