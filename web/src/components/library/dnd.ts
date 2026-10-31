import { useState, type DragEvent } from 'react'

const MIME = 'application/x-ulka-videos'

/** Starts dragging videos (by id); folders and the folder tree accept them. */
export function startDrag(e: DragEvent, ids: string[]) {
  e.dataTransfer.setData(MIME, JSON.stringify(ids))
  e.dataTransfer.effectAllowed = 'move'
}

const carries = (e: DragEvent) => e.dataTransfer.types.includes(MIME)

/** Makes an element accept dragged videos: spread `props` on it, and style it while `over`. */
export function useVideoDrop(onDrop: (ids: string[]) => void) {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!carries(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        if (!carries(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        try {
          const ids = JSON.parse(e.dataTransfer.getData(MIME)) as string[]
          if (ids.length) onDrop(ids)
        } catch {
          // not ours
        }
      },
    },
  }
}
