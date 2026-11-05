import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { copyText } from '@/lib/clipboard'

/** How long "Copied" shows before the menu closes. */
const COPIED_FEEDBACK_MS = 600

interface CellMenuTarget {
  value: unknown
  items?: () => ReactNode
}

/** A cell value as text to copy: lists joined, objects as JSON, null as empty. */
export function cellText(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(cellText).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * The right-click menu of one table's cells. Each cell passes `on(value)` as its
 * `onContextMenu`: the event bubbles from the cell to the table body, where the
 * single menu reads what the cell recorded — one menu per table, not per cell.
 * `items` adds row-level entries under "Copy value"; it is a thunk so a table
 * builds them only for the cell actually right-clicked.
 */
export function useCellContextMenu() {
  const pending = useRef<CellMenuTarget | null>(null)
  return useMemo(
    () => ({
      on: (value: unknown, items?: () => ReactNode) => () => {
        pending.current = { value, items }
      },
      /** What the right-clicked cell recorded, consumed once. */
      take: (): CellMenuTarget | null => {
        const hit = pending.current
        pending.current = null
        return hit
      },
    }),
    [],
  )
}

/**
 * Wraps a table body (`<TableBody>`, passed through `asChild`). A right-click
 * outside any registered cell — the empty-state row, a skeleton — opens nothing.
 */
export function CellContextMenu({
  menu,
  children,
}: {
  menu: ReturnType<typeof useCellContextMenu>
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [target, setTarget] = useState<{ text: string; items?: ReactNode } | null>(null)
  const [copied, setCopied] = useState(false)
  const copyItem = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  // The first select copies and keeps the menu open on "Copied"; the timer then
  // clicks the item again, and that second select closes the menu the normal way.
  const onCopySelect = (e: Event) => {
    if (copied) return
    e.preventDefault()
    if (!target?.text) return
    void copyText(target.text).then((ok) => {
      if (!ok) return
      setCopied(true)
      closeTimer.current = setTimeout(() => {
        if (copyItem.current?.isConnected) copyItem.current.click()
      }, COPIED_FEEDBACK_MS)
    })
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        // The trigger adds select-none; table text stays selectable.
        className="select-auto"
        onContextMenu={(e) => {
          const hit = menu.take()
          if (!hit) {
            e.preventDefault()
            return
          }
          if (closeTimer.current) clearTimeout(closeTimer.current)
          setCopied(false)
          setTarget({ text: cellText(hit.value), items: hit.items?.() })
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem ref={copyItem} disabled={!target?.text} onSelect={onCopySelect}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? t('common.copied') : t('common.copy_cell_value')}
        </ContextMenuItem>
        {target?.items && (
          <>
            <ContextMenuSeparator />
            {target.items}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
