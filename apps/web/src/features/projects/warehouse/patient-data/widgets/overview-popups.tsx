import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { copyText } from '@/lib/clipboard'
import type { OverviewConceptRow, OverviewRow } from './overview-layout'
import { rowLabel } from './overview-row-label'

/** A tooltip's content plus where the pointer was, in viewport coordinates. */
export interface TipContent {
  title: string
  /** Vocabulary code, shown small and muted directly under the name. */
  code?: string | null
  /** The headline figure, shown large: a value with its unit, or a unit name. */
  value?: string
  lines: string[]
  x: number
  y: number
}

/**
 * Hover tooltip, in the prototype's layout: the name on top, the value large
 * beneath it, then the timing in muted text.
 *
 * Rendered through a portal to document.body. Each react-grid item is a
 * transformed stacking context, and a `fixed` element inside a CSS transform is
 * positioned relative to THAT ancestor rather than the viewport — so a tooltip
 * left in place drifts by the widget's own screen offset, which is why it moved
 * when the sidebar was collapsed.
 */
export function HoverTip({ tip }: { tip: TipContent }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: tip.x + 14, top: tip.y + 16 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Measured after paint, because flipping near an edge needs the real size.
    const r = el.getBoundingClientRect()
    const left = Math.max(
      6,
      tip.x + 14 + r.width > window.innerWidth - 8 ? tip.x - r.width - 14 : tip.x + 14,
    )
    const top = Math.max(
      6,
      tip.y + 16 + r.height > window.innerHeight - 8 ? tip.y - r.height - 10 : tip.y + 16,
    )
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }))
  }, [tip])

  return createPortal(
    <div
      ref={ref}
      className="pointer-events-none fixed z-[9999] max-w-[340px] space-y-1 rounded-md bg-slate-900 px-3 py-2 text-white shadow-lg"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="text-xs font-semibold leading-normal">{tip.title}</div>
      {tip.code && <div className="text-[10px] leading-normal text-slate-400">{tip.code}</div>}
      {tip.value && <div className="text-xs leading-normal text-slate-100">{tip.value}</div>}
      {tip.lines.map((line, i) => (
        <div key={i} className="text-[10px] leading-normal text-slate-400">
          {line}
        </div>
      ))}
    </div>,
    document.body,
  )
}

/** Right-click actions on a category: fold it, or mute it. */
export function CategoryMenu({
  row,
  x,
  y,
  rows,
  collapsed,
  hidden,
  onClose,
  onChanged,
  t,
}: {
  row: OverviewRow
  x: number
  y: number
  rows: OverviewRow[]
  collapsed: Set<string>
  hidden: Set<string>
  onClose: () => void
  onChanged: () => void
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, innerWidth - r.width - 6),
      top: Math.min(y, innerHeight - r.height - 6),
    })
  }, [x, y])

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  const name = rowLabel(row, t)
  const isClass = row.kind === 'class'
  // A class row folds only its class; a table row folds the whole table.
  const key = isClass ? row.key : row.table
  const tables = [...new Set(rows.filter((r) => r.kind === 'table').map((r) => r.table))]
  const classesHere = rows.filter((r) => r.kind === 'class' && r.table === row.table)

  const act = (fn: () => void) => () => {
    fn()
    onClose()
    onChanged()
  }
  const toggle = (set: Set<string>, k: string) => (set.has(k) ? set.delete(k) : set.add(k))

  const items: ({ sep: true } | { label: string; icon: string; run: () => void })[] = [
    collapsed.has(key)
      ? { label: t('patient_data.overview_expand', { name }), icon: 'expand', run: () => collapsed.delete(key) }
      : { label: t('patient_data.overview_collapse', { name }), icon: 'collapse', run: () => collapsed.add(key) },
    ...(isClass
      ? [
          {
            label: t('patient_data.overview_collapse_other_classes'),
            icon: 'others',
            run: () => {
              for (const c of classesHere) {
                if (c.key === key) collapsed.delete(c.key)
                else collapsed.add(c.key)
              }
            },
          },
        ]
      : [
          {
            label: t('patient_data.overview_collapse_others'),
            icon: 'others',
            run: () => {
              for (const tb of tables) {
                if (tb === row.table) collapsed.delete(tb)
                else collapsed.add(tb)
              }
            },
          },
          {
            label: t('patient_data.overview_expand_others'),
            icon: 'others',
            run: () => {
              for (const tb of tables) {
                if (tb === row.table) collapsed.add(tb)
                else collapsed.delete(tb)
              }
            },
          },
        ]),
    { label: t('patient_data.overview_collapse_all'), icon: 'collapseAll', run: () => tables.forEach((tb) => collapsed.add(tb)) },
    { label: t('patient_data.overview_expand_all'), icon: 'expandAll', run: () => collapsed.clear() },
    { sep: true },
    hidden.has(key)
      ? { label: t('patient_data.overview_show', { name }), icon: 'show', run: () => hidden.delete(key) }
      : { label: t('patient_data.overview_hide', { name }), icon: 'hide', run: () => toggle(hidden, key) },
    ...(isClass
      ? [
          {
            label: t('patient_data.overview_hide_other_classes'),
            icon: 'hide',
            run: () => {
              for (const c of classesHere) {
                if (c.key === key) hidden.delete(c.key)
                else hidden.add(c.key)
              }
            },
          },
        ]
      : [
          {
            label: t('patient_data.overview_hide_others'),
            icon: 'hide',
            run: () => {
              for (const tb of tables) {
                if (tb === row.table) hidden.delete(tb)
                else hidden.add(tb)
              }
            },
          },
          {
            label: t('patient_data.overview_show_others'),
            icon: 'show',
            run: () => {
              for (const tb of tables) {
                if (tb === row.table) hidden.add(tb)
                else hidden.delete(tb)
              }
            },
          },
        ]),
    { label: t('patient_data.overview_show_all'), icon: 'show', run: () => hidden.clear() },
  ]

  // Portalled for the same reason as the tooltip: `fixed` inside a react-grid
  // item is positioned against that transformed ancestor, not the viewport.
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[200px] rounded-md border bg-popover p-1 shadow-md"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((it, i) =>
        'sep' in it ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={i}
            type="button"
            onClick={act(it.run)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
          >
            <MenuIcon name={it.icon} />
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

/**
 * Menu icons. The pairs are deliberately mirror images — chevron down/right for
 * expand and collapse, open/struck eye for show and hide — so the two axes
 * (fold vs mute) stay distinguishable at a glance.
 */
function MenuIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    expand: 'M3 5.5 L7 9.5 L11 5.5',
    collapse: 'M5.5 3 L9.5 7 L5.5 11',
    expandAll: 'M3 4 L7 8 L11 4 M3 8.5 L7 12.5 L11 8.5',
    collapseAll: 'M3 7 L7 3 L11 7 M3 11.5 L7 7.5 L11 11.5',
    show: 'M1 7 C3 3.5 11 3.5 13 7 C11 10.5 3 10.5 1 7 Z M5.2 7 A1.8 1.8 0 1 0 8.8 7 A1.8 1.8 0 1 0 5.2 7',
    hide: 'M1 7 C3 3.5 11 3.5 13 7 C11 10.5 3 10.5 1 7 Z M2 12 L12 2',
    others: 'M2 3.5 L12 3.5 M2 7 L12 7 M2 10.5 L12 10.5',
    copy: 'M5 5 L5 2.5 L12 2.5 L12 9.5 L9.5 9.5 M2 5 L9 5 L9 12 L2 12 Z',
    check: 'M2.5 7.5 L5.5 10.5 L11.5 3.5',
  }
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name] ?? ''} />
    </svg>
  )
}

export function Message({ text, tone }: { text: string; tone?: 'error' }) {
  return (
    <div
      className={`flex h-full items-center justify-center p-4 text-center text-xs ${
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
      }`}
    >
      {text}
    </div>
  )
}

/**
 * Right-click actions on a data point: carry the concept's identifiers out.
 *
 * The name is what you read, but the id and the code are what you paste into a
 * query or a vocabulary browser — and neither is selectable on a canvas.
 */
export function ConceptCopyMenu({
  concept,
  x,
  y,
  onClose,
  t,
}: {
  concept: OverviewConceptRow
  x: number
  y: number
  onClose: () => void
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, innerWidth - r.width - 6),
      top: Math.min(y, innerHeight - r.height - 6),
    })
  }, [x, y])

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  // The menu stays open briefly after a copy so the tick is actually seen.
  const copy = (value: string, key: string) => () => {
    void copyText(value).then((ok) => {
      if (!ok) return
      setCopied(key)
      setTimeout(onClose, 600)
    })
  }

  const items = [
    { key: 'name', label: t('patient_data.overview_copy_name'), value: concept.conceptName },
    { key: 'id', label: t('patient_data.overview_copy_id'), value: concept.conceptId },
    ...(concept.conceptCode
      ? [{ key: 'code', label: t('patient_data.overview_copy_code'), value: concept.conceptCode }]
      : []),
  ]

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[220px] rounded-md border bg-popover p-1 shadow-md"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="truncate px-2 py-1 text-[10px] text-muted-foreground">
        {concept.conceptName}
      </div>
      <div className="my-1 h-px bg-border" />
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={copy(it.value, it.key)}
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
        >
          <MenuIcon name={copied === it.key ? 'check' : 'copy'} />
          <span className="flex-1 truncate">{it.label}</span>
          <span className="max-w-[90px] truncate font-mono text-[10px] text-muted-foreground">
            {it.value}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
