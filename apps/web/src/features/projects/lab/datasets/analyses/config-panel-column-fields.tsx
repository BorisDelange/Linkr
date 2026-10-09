import { useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, GripVertical } from 'lucide-react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchInput } from '@/components/ui/search-input'
import { firstMatchOnEnter, selectMatchesOnEnter } from '@/components/ui/search-enter'
import { SelectionTriggerLabel } from '@/components/ui/selection-trigger-label'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/ui/section-label'
import { displayColumnName, displayCellValue, toComparableString } from '@/lib/dataset-utils'
import { defaultAnalysisColumns } from '@/lib/analysis-default-columns'
import { useBooleanLabels } from '@/hooks/use-boolean-labels'
import type { DatasetColumn } from '@/types'
import { useServerColumnDistinct } from './use-server-column-distinct'
import { useColumnHint, filterColumns } from './config-panel-helpers'
import { FieldLabel, type FieldRendererProps } from './config-panel-field-label'

// ---------------------------------------------------------------------------
// Multi column-select (checkbox list)
// ---------------------------------------------------------------------------

export function MultiColumnSelect({
  fieldKey,
  field,
  value,
  columns,
  lang,
  config,
  onConfigChange,
  rows,
}: FieldRendererProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const filtered = filterColumns(columns, field.filter)
  const hintFor = useColumnHint(field, columns, rows)
  // Memoized: the `??` fallback builds a fresh array each render, which would
  // otherwise re-run every hook that depends on `selected` on every render.
  const selected = useMemo(
    () => (value as string[] | undefined)
      ?? (field.defaultAll ? defaultAnalysisColumns(filtered).map(c => c.id) : []),
    [value, field.defaultAll, filtered],
  )

  const toggle = useCallback(
    (colId: string) => {
      const next = selected.includes(colId)
        ? selected.filter(id => id !== colId)
        : [...selected, colId]
      onConfigChange({ [fieldKey]: next })
    },
    [fieldKey, selected, onConfigChange],
  )

  const selectAll = useCallback(() => {
    onConfigChange({ [fieldKey]: filtered.map(c => c.id) })
  }, [fieldKey, filtered, onConfigChange])

  const selectNone = useCallback(() => {
    onConfigChange({ [fieldKey]: [] })
  }, [fieldKey, onConfigChange])

  // Search both the label and the storage name: the list DISPLAYS labels, so
  // typing what you can see must match, but the name stays searchable for
  // someone who knows the column by how it is stored.
  const searchFiltered = useMemo(() => {
    if (!search.trim()) return filtered
    const q = search.toLowerCase()
    return filtered.filter(
      c => displayColumnName(c, lang).toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    )
  }, [filtered, search, lang])

  const selectMatches = () => {
    const next = selectMatchesOnEnter(search, selected, searchFiltered.map(c => c.id))
    if (!next) return
    if (next !== selected) onConfigChange({ [fieldKey]: [...next] })
    setOpen(false)
    setSearch('')
  }

  // Column LABELS, not ids: the trigger is read, so it should say what the user
  // named the column rather than its storage name.
  //
  // Ordered by `selected` rather than by the column list when the field is
  // orderable: the trigger then previews the order the table will actually use.
  const selectedLabels = useMemo(() => {
    const byId = new Map(filtered.map(c => [c.id, c]))
    if (field.orderable) {
      return selected
        .map(id => byId.get(id))
        .filter((c): c is DatasetColumn => !!c)
        .map((c) => displayColumnName(c, lang))
    }
    return filtered.filter(c => selected.includes(c.id)).map((c) => displayColumnName(c, lang))
  }, [filtered, selected, field.orderable, lang])

  const reorder = useCallback(
    (next: string[]) => onConfigChange({ [fieldKey]: next }),
    [fieldKey, onConfigChange],
  )

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-8 w-full items-center justify-between rounded-md border px-3 text-xs hover:bg-accent/50 transition-colors"
          >
            <SelectionTriggerLabel
              labels={selectedLabels}
              total={filtered.length}
              className="text-muted-foreground"
            />
            <ChevronsUpDown size={12} className="ml-1 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2 bg-popover" align="start">
          <SearchInput
            value={search}
            onChange={setSearch}
            onEnter={selectMatches}
            placeholder={t('common.search')}
            size="dense"
            className="mb-2"
          />
          <div className="mb-2 flex items-center gap-1">
            <button onClick={selectAll} className="text-[10px] text-muted-foreground hover:text-foreground">
              {t('common.select_all')}
            </button>
            <span className="text-[10px] text-muted-foreground">/</span>
            <button onClick={selectNone} className="text-[10px] text-muted-foreground hover:text-foreground">
              {t('common.select_none')}
            </button>
          </div>
          <div
            className="max-h-[200px] overflow-y-auto overscroll-contain rounded-md border divide-y divide-border bg-popover"
            onWheel={e => { e.stopPropagation(); e.currentTarget.scrollTop += e.deltaY }}
          >
            {searchFiltered.map(col => {
              const isSelected = selected.includes(col.id)
              return (
                <button
                  key={col.id}
                  onClick={() => toggle(col.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-2 py-1.5 text-xs transition-colors',
                    isSelected ? 'bg-accent/60 text-accent-foreground' : 'hover:bg-accent/30',
                  )}
                >
                  <div
                    className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                      isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30',
                    )}
                  >
                    {isSelected && <Check size={10} />}
                  </div>
                  <span className="truncate" title={col.name}>{displayColumnName(col, lang)}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
                    {hintFor(col)}
                  </span>
                </button>
              )
            })}
            {searchFiltered.length === 0 && (
              <p className="py-2 text-center text-[10px] text-muted-foreground">{t('common.no_results')}</p>
            )}
          </div>
          {/* The order editor only appears once the user has asked for a custom
              order — otherwise it invites dragging that the sort would discard. */}
          {field.orderable && config.variableOrder === 'custom' && selected.length > 1 && (
            <SelectedColumnOrderList selected={selected} columns={filtered} onReorder={reorder} />
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/**
 * Drag-to-reorder list of the CHOSEN columns, in the order the table will read.
 *
 * Separate from the checkbox list above it because the two answer different
 * questions — which variables, then in what order — and merging them would make
 * a long dataset's list unusable: you would have to scroll past unselected
 * columns to move one selected row past another.
 */
function SelectedColumnOrderList({
  selected,
  columns,
  onReorder,
}: {
  selected: string[]
  columns: DatasetColumn[]
  onReorder: (next: string[]) => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  // A small distance before a drag starts, or the click that ticks a checkbox
  // is swallowed as a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const byId = useMemo(() => new Map(columns.map(c => [c.id, c])), [columns])
  const ordered = useMemo(() => selected.filter(id => byId.has(id)), [selected, byId])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const from = ordered.indexOf(String(active.id))
      const to = ordered.indexOf(String(over.id))
      if (from < 0 || to < 0) return
      onReorder(arrayMove(ordered, from, to))
    },
    [ordered, onReorder],
  )

  return (
    <div className="mt-2 border-t pt-2">
      <SectionLabel as="p" className="mb-1">
        {t('datasets.table1_row_order')}
      </SectionLabel>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ordered} strategy={verticalListSortingStrategy}>
          <div className="max-h-[160px] overflow-y-auto overscroll-contain rounded-md border divide-y divide-border">
            {ordered.map((id, i) => (
              <SortableColumnRow
                key={id}
                id={id}
                index={i}
                label={displayColumnName(byId.get(id)!, lang)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

export function SortableColumnRow({ id, index, label }: { id: string; index: number; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 bg-popover px-2 py-1.5 text-xs',
        isDragging && 'relative z-10 opacity-80 shadow-sm',
      )}
      {...attributes}
      {...listeners}
    >
      <GripVertical size={12} className="shrink-0 cursor-grab text-muted-foreground/50" />
      <span className="w-4 shrink-0 text-[10px] text-muted-foreground/60">{index + 1}</span>
      <span className="truncate">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single column-select (dropdown)
// ---------------------------------------------------------------------------

export function SingleColumnSelect({
  fieldKey,
  field,
  value,
  columns,
  lang,
  config,
  onConfigChange,
  rows,
}: FieldRendererProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const filtered = filterColumns(columns, field.filter)
  const current = (value as string | undefined) ?? ''
  const currentCol = filtered.find(c => c.id === current)

  const hintFor = useColumnHint(field, columns, rows)

  const handleSelect = useCallback((colId: string | undefined) => {
    const changes: Record<string, unknown> = { [fieldKey]: colId }
    // Auto-set linked fields based on column type
    if (colId && field.autoSet) {
      const col = columns.find(c => c.id === colId)
      if (col) {
        const isNumeric = col.type === 'number'
        const autoValues = isNumeric ? field.autoSet.numeric : field.autoSet.categorical
        if (autoValues) Object.assign(changes, autoValues)
      }
    }
    onConfigChange(changes)
    setOpen(false)
    setSearch('')
  }, [fieldKey, field.autoSet, columns, onConfigChange])

  // Search both the label and the storage name: the list DISPLAYS labels, so
  // typing what you can see must match, but the name stays searchable for
  // someone who knows the column by how it is stored.
  const searchFiltered = useMemo(() => {
    if (!search.trim()) return filtered
    const q = search.toLowerCase()
    return filtered.filter(
      c => displayColumnName(c, lang).toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    )
  }, [filtered, search, lang])

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-8 w-full items-center justify-between rounded-md border px-3 text-xs hover:bg-accent/50 transition-colors"
          >
            <span className={cn('truncate', !currentCol && 'text-muted-foreground')}>
              {currentCol ? displayColumnName(currentCol, lang) : t('common.none')}
            </span>
            <ChevronsUpDown size={12} className="ml-1 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2 bg-popover" align="start">
          {filtered.length > 5 && (
            <SearchInput
              value={search}
              onChange={setSearch}
              onEnter={() => {
                const first = firstMatchOnEnter(search, searchFiltered)
                if (first) handleSelect(first.id)
              }}
              placeholder={t('common.search')}
              size="dense"
              className="mb-2"
            />
          )}
          <div
            className="max-h-[200px] overflow-y-auto overscroll-contain rounded-md border divide-y divide-border bg-popover"
            onWheel={e => { e.stopPropagation(); e.currentTarget.scrollTop += e.deltaY }}
          >
            {field.optional && (
              <button
                onClick={() => handleSelect(undefined)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1.5 text-xs transition-colors',
                  !current ? 'bg-accent/60 text-accent-foreground' : 'hover:bg-accent/30',
                )}
              >
                <span className="text-muted-foreground">{t('common.none')}</span>
              </button>
            )}
            {searchFiltered.map(col => {
              const isSelected = col.id === current
              return (
                <button
                  key={col.id}
                  onClick={() => handleSelect(col.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-2 py-1.5 text-xs transition-colors',
                    isSelected ? 'bg-accent/60 text-accent-foreground' : 'hover:bg-accent/30',
                  )}
                >
                  <span className="truncate" title={col.name}>{displayColumnName(col, lang)}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
                    {hintFor(col)}
                  </span>
                </button>
              )
            })}
            {searchFiltered.length === 0 && (
              <p className="py-2 text-center text-[10px] text-muted-foreground">{t('common.no_results')}</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Column-value select (unique values from a column, as a dropdown)
// ---------------------------------------------------------------------------

export function ColumnValueSelect({
  fieldKey,
  field,
  value,
  columns: _columns,
  lang,
  config,
  onConfigChange,
  rows,
  datasetFileId,
}: FieldRendererProps) {
  const { t } = useTranslation()
  const booleanLabels = useBooleanLabels()
  const columnFieldId = config[field.columnField ?? ''] as string | undefined
  const valueCol = useMemo(() => _columns.find(c => c.id === columnFieldId), [_columns, columnFieldId])
  const current = (value as string | undefined) ?? ''

  const localValues = useMemo(() => {
    if (!columnFieldId || !rows) return []
    const seen = new Set<string>()
    for (const row of rows) {
      const raw = row[columnFieldId]
      if (raw != null) seen.add(toComparableString(raw))
    }
    return Array.from(seen).sort()
  }, [columnFieldId, rows])

  const serverValues = useServerColumnDistinct(columnFieldId, rows, datasetFileId)
  const uniqueValues = localValues.length > 0 ? localValues : serverValues

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Select
        value={current || '__none__'}
        onValueChange={v => onConfigChange({ [fieldKey]: v === '__none__' ? '' : v })}
      >
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t('common.auto')}</SelectItem>
          {uniqueValues.map(val => (
            <SelectItem key={val} value={val}>
              {valueCol ? displayCellValue(valueCol, val, booleanLabels) : val}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
