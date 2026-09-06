import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'

type InsertSide = 'left' | 'right'

/**
 * Reordering a tab strip with native HTML5 drag & drop.
 *
 * Native drag is what keeps the ghost faithful: the browser snapshots the tab
 * as rendered. dnd-kit instead moves the real node through a transform that
 * carries a scale factor (initial width / current width), which stretches the
 * label of any tab whose width differs from the one it lands on.
 *
 * `mimeType` scopes a drag to one strip — a bare id would let a tab be dropped
 * into the neighbouring group, which reorders nothing and looks broken.
 */
export function useTabReorder(mimeType: string, onReorder: (fromIndex: number, toIndex: number) => void) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropInsert, setDropInsert] = useState<{ id: string; side: InsertSide } | null>(null)

  const tabProps = useCallback(
    (id: string, ids: string[]) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(mimeType, id)
        e.dataTransfer.effectAllowed = 'move'
        setDragId(id)
      },
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(mimeType)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        setDropInsert({ id, side: e.clientX < rect.left + rect.width / 2 ? 'left' : 'right' })
      },
      onDragLeave: () => setDropInsert(null),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        const draggedId = e.dataTransfer.getData(mimeType)
        const side = dropInsert?.side ?? 'left'
        setDragId(null)
        setDropInsert(null)
        if (!draggedId || draggedId === id) return
        const fromIdx = ids.indexOf(draggedId)
        let toIdx = ids.indexOf(id)
        // Dropping on the right half inserts after the target; removing the
        // dragged tab first shifts every later index down by one.
        if (side === 'right') toIdx++
        if (fromIdx < toIdx) toIdx--
        if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) onReorder(fromIdx, toIdx)
      },
      onDragEnd: () => {
        setDragId(null)
        setDropInsert(null)
      },
    }),
    [mimeType, dropInsert, onReorder],
  )

  const insertCaret = useCallback(
    (id: string, side: InsertSide) =>
      dropInsert?.id === id && dropInsert.side === side && dragId !== id,
    [dropInsert, dragId],
  )

  return { dragId, tabProps, insertCaret }
}

/** The 2px bar marking where a dropped tab will land. */
export function TabInsertCaret({ side }: { side: InsertSide }) {
  return (
    <div
      className={cn('absolute top-1 bottom-1 w-0.5 rounded-full bg-primary', side === 'left' ? 'left-0' : 'right-0')}
    />
  )
}
