import { useCallback, useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Puzzle, ChevronsUpDown, Info, Ban, ChevronRight, GripVertical } from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import * as LucideIcons from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { SelectionTriggerLabel } from '@/components/ui/selection-trigger-label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/ui/section-label'
import { localized } from '@/lib/localized'
import { displayColumnName, displayCellValue } from '@/lib/dataset-utils'
import { defaultAnalysisColumns } from '@/lib/analysis-default-columns'
import { inferSurveySchema } from '@/lib/survey/survey-infer'
import { questionColumns, questionChoices } from '@/lib/survey/survey-schema'
import { availableCharts } from './survey-charts'
import { questionKindLabel } from '@/lib/survey/question-kind-label'
import { useBooleanLabels } from '@/hooks/use-boolean-labels'
import { isServerMode } from '@/lib/api-client'
import { fetchColumnDistinct } from '@/lib/api/datasets'
import { ColorPickerPopover } from '@/components/ui/color-picker-popover'
import { PaletteEditor } from '@/components/ui/palette-editor'
import { CHART_PALETTES } from '@/lib/plugins/shared-styles'
import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'

interface GenericConfigPanelProps {
  schema: Record<string, PluginConfigField>
  config: Record<string, unknown>
  columns: DatasetColumn[]
  onConfigChange: (changes: Record<string, unknown>) => void
  /** Data rows — needed for column-value-select fields. */
  rows?: Record<string, unknown>[]
  /** Dataset file id — lets column-value-select fetch distinct values from the
   *  server when `rows` is empty (server mode), instead of showing nothing. */
  datasetFileId?: string
  /** Renders a `concept-select` field (warehouse scope only). Absent in the lab,
   *  where no schema declares that type — the field then renders nothing. */
  renderConceptField?: (fieldKey: string, field: PluginConfigField) => React.ReactNode
}

export function GenericConfigPanel({
  schema,
  config,
  columns,
  onConfigChange,
  rows,
  datasetFileId,
  renderConceptField,
}: GenericConfigPanelProps) {
  const { i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'

  const configWithDefaults = useMemo(() => {
    const result = { ...config }
    for (const [key, field] of Object.entries(schema)) {
      if (result[key] === undefined && field.default !== undefined) {
        result[key] = field.default
      }
    }
    return result
  }, [config, schema])

  const visibleEntries = Object.entries(schema).filter(([, field]) => {
    if (!field.visibleWhen) return true
    const conditions = Array.isArray(field.visibleWhen) ? field.visibleWhen : [field.visibleWhen]
    return conditions.every(cond => {
      const depValue = configWithDefaults[cond.field]
      if (cond.notEmpty) return depValue != null && depValue !== '' && depValue !== undefined
      if (cond.values) return cond.values.includes(depValue)
      return depValue === cond.value
    })
  })

  // Group fields by `row` — fields with the same row value are rendered side-by-side
  const groups: { keys: string[]; fields: PluginConfigField[] }[] = []
  const seen = new Set<number>()
  for (let i = 0; i < visibleEntries.length; i++) {
    if (seen.has(i)) continue
    const [, field] = visibleEntries[i]
    if (field.row) {
      const rowKeys: string[] = []
      const rowFields: PluginConfigField[] = []
      for (let j = i; j < visibleEntries.length; j++) {
        if (visibleEntries[j][1].row === field.row) {
          seen.add(j)
          rowKeys.push(visibleEntries[j][0])
          rowFields.push(visibleEntries[j][1])
        }
      }
      groups.push({ keys: rowKeys, fields: rowFields })
    } else {
      seen.add(i)
      groups.push({ keys: [visibleEntries[i][0]], fields: [visibleEntries[i][1]] })
    }
  }

  type SectionBlock = { sectionLabel: string | null; defaultOpen: boolean; groups: typeof groups }
  const sectionBlocks: SectionBlock[] = []
  for (const group of groups) {
    // Determine section from the first field that has one
    const sectionDef = group.fields.find(f => f.section)?.section
    const label = sectionDef ? (sectionDef[lang] ?? sectionDef.en) : null
    const defaultOpen = sectionDef?.defaultOpen !== false // default true
    const last = sectionBlocks[sectionBlocks.length - 1]
    if (last && last.sectionLabel === label) {
      last.groups.push(group)
    } else {
      sectionBlocks.push({ sectionLabel: label, defaultOpen, groups: [group] })
    }
  }

  const renderGroups = (gs: typeof groups) =>
    gs.map((group) => {
      const allBoolean = group.fields.every(f => f.type === 'boolean')
      // Booleans and color swatches are intrinsically narrow; stretching them across a
      // 50/50 grid leaves big awkward gaps. Pack them left with a small gap instead.
      const packLeft = group.fields.every(f => f.type === 'boolean' || f.type === 'color-select')
      // "Field + trailing booleans": give the leading field half the width and pack the
      // booleans into the other half (e.g. Decimals | [X axis starts at 0, Show grid]).
      const fieldThenBooleans =
        group.fields.length > 1 &&
        group.fields[0].type !== 'boolean' &&
        group.fields.slice(1).every(f => f.type === 'boolean')
      return group.keys.length === 1 ? (
        <FieldRenderer
          key={group.keys[0]}
          fieldKey={group.keys[0]}
          field={group.fields[0]}
          value={configWithDefaults[group.keys[0]]}
          columns={columns}
          lang={lang}
          config={configWithDefaults}
          onConfigChange={onConfigChange}
          rows={rows}
          datasetFileId={datasetFileId}
          renderConceptField={renderConceptField}
        />
      ) : fieldThenBooleans ? (
        <div key={group.keys.join('-')} className="grid items-end gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <FieldRenderer
            fieldKey={group.keys[0]}
            field={group.fields[0]}
            value={configWithDefaults[group.keys[0]]}
            columns={columns}
            lang={lang}
            config={configWithDefaults}
            onConfigChange={onConfigChange}
            rows={rows}
            datasetFileId={datasetFileId}
            renderConceptField={renderConceptField}
          />
          <div className="flex flex-wrap items-end gap-x-5 gap-y-1">
            {group.keys.slice(1).map((key, idx) => (
              <FieldRenderer
                key={key}
                fieldKey={key}
                field={group.fields[idx + 1]}
                value={configWithDefaults[key]}
                columns={columns}
                lang={lang}
                config={configWithDefaults}
                onConfigChange={onConfigChange}
                rows={rows}
                datasetFileId={datasetFileId}
                renderConceptField={renderConceptField}
              />
            ))}
          </div>
        </div>
      ) : packLeft ? (
        // Tighter vertical gap so color swatches wrapping onto a second line don't leave a big gap.
        <div
          key={group.keys.join('-')}
          className={cn(
            allBoolean
              // Evenly divided rather than packed left: two checkboxes each
              // take half the panel, three a third, so the column of controls
              // lines up instead of stepping in with each label's length.
              ? 'grid gap-x-3 gap-y-1'
              : 'flex flex-wrap items-end gap-x-4 gap-y-1.5',
          )}
          style={
            allBoolean
              ? { gridTemplateColumns: `repeat(${Math.min(group.keys.length, 3)}, minmax(0, 1fr))` }
              : undefined
          }
        >
          {group.keys.map((key, idx) => (
            <FieldRenderer
              key={key}
              fieldKey={key}
              field={group.fields[idx]}
              value={configWithDefaults[key]}
              columns={columns}
              lang={lang}
              config={configWithDefaults}
              onConfigChange={onConfigChange}
              rows={rows}
              datasetFileId={datasetFileId}
              renderConceptField={renderConceptField}
            />
          ))}
        </div>
      ) : (
        <div key={group.keys.join('-')} className="grid gap-4" style={{ gridTemplateColumns: `repeat(${group.keys.length}, minmax(0, 1fr))` }}>
          {group.keys.map((key, idx) => (
            <FieldRenderer
              key={key}
              fieldKey={key}
              field={group.fields[idx]}
              value={configWithDefaults[key]}
              columns={columns}
              lang={lang}
              config={configWithDefaults}
              onConfigChange={onConfigChange}
              rows={rows}
              datasetFileId={datasetFileId}
              renderConceptField={renderConceptField}
            />
          ))}
        </div>
      )
    })

  return (
    <div className="space-y-3 p-3">
      {sectionBlocks.map((block, i) =>
        block.sectionLabel ? (
          <CollapsibleSection key={block.sectionLabel + i} label={block.sectionLabel} defaultOpen={block.defaultOpen}>
            {renderGroups(block.groups)}
          </CollapsibleSection>
        ) : (
          renderGroups(block.groups)
        ),
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------

function CollapsibleSection({ label, defaultOpen = true, children }: { label: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md bg-blue-50 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-blue-700 hover:bg-blue-100 transition-colors dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/50">
        <ChevronRight size={13} className={cn('shrink-0 text-blue-400 transition-transform dark:text-blue-500', open && 'rotate-90')} />
        {label}
      </CollapsibleTrigger>
      {/* config-section, not space-y-3: the sibling margin has to differ per pair
          (tight between two checkboxes, normal otherwise), and space-y-* sets one
          margin on every sibling — it would just override the narrower rule. */}
      <CollapsibleContent className="config-section pt-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

// ---------------------------------------------------------------------------
// Hint resolver — shows contextual badges (e.g. "required", "optional") next to labels
// ---------------------------------------------------------------------------

function resolveHint(
  field: PluginConfigField,
  config: Record<string, unknown>,
  lang: 'en' | 'fr',
): string | null {
  if (field.hintWhen) {
    const depValue = String(config[field.hintWhen.field] ?? '')
    // An override swaps specific hints when a second field matches (e.g. flip X/Y by orientation).
    // Override keys take precedence; missing keys fall back to the base map.
    const ov = field.hintWhen.override
    const values = ov && config[ov.field] === ov.value
      ? { ...field.hintWhen.values, ...ov.values }
      : field.hintWhen.values
    const label = values[depValue]
    if (label) return label[lang] ?? label.en
    return null
  }
  if (field.hint) return field.hint[lang] ?? field.hint.en
  return null
}

function HintBadge({ text }: { text: string }) {
  const isRequired = /required|requis/i.test(text)
  return (
    <span
      className={cn(
        'ml-1 shrink-0 rounded px-1 py-px text-[9px] font-medium leading-tight',
        isRequired
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {text}
    </span>
  )
}

function FieldLabel({ field, config, lang }: { field: PluginConfigField; config: Record<string, unknown>; lang: 'en' | 'fr' }) {
  const hint = resolveHint(field, config, lang)
  const desc = field.description ? (field.description[lang] ?? field.description.en) : null
  return (
    <Label className="text-xs flex items-center">
      {field.label[lang] ?? field.label.en}
      {hint && <HintBadge text={hint} />}
      {desc && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info size={12} className="ml-1 shrink-0 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-56 whitespace-pre-line">
              {desc}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </Label>
  )
}

// ---------------------------------------------------------------------------

interface FieldRendererProps {
  fieldKey: string
  field: PluginConfigField
  value: unknown
  columns: DatasetColumn[]
  lang: 'en' | 'fr'
  config: Record<string, unknown>
  onConfigChange: (changes: Record<string, unknown>) => void
  rows?: Record<string, unknown>[]
  datasetFileId?: string
  renderConceptField?: (fieldKey: string, field: PluginConfigField) => React.ReactNode
}

function FieldRenderer({ fieldKey, field, value, columns, lang, config, onConfigChange, rows, datasetFileId, renderConceptField }: FieldRendererProps) {
  switch (field.type) {
    // Warehouse-only: the host supplies the picker, so this panel stays free of
    // any OMOP dependency.
    case 'concept-select':
      return renderConceptField ? renderConceptField(fieldKey, field) : null
    case 'column-select':
      return field.multi ? (
        <MultiColumnSelect
          fieldKey={fieldKey}
          field={field}
          value={value}
          columns={columns}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      ) : (
        <SingleColumnSelect
          fieldKey={fieldKey}
          field={field}
          value={value}
          columns={columns}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      )
    case 'column-value-select':
      return (
        <ColumnValueSelect
          fieldKey={fieldKey}
          field={field}
          value={value}
          columns={columns}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
          rows={rows}
          datasetFileId={datasetFileId}
          renderConceptField={renderConceptField}
        />
      )
    case 'select':
      return field.multi ? (
        <MultiSelectField
          fieldKey={fieldKey}
          field={field}
          value={value}
          columns={columns}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      ) : (
        <SelectField
          fieldKey={fieldKey}
          field={field}
          value={value}
          columns={columns}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
          rows={rows}
        />
      )
    case 'number':
      return (
        <NumberField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      )
    case 'boolean':
      return (
        <BooleanField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      )
    case 'string':
      return (
        <StringField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      )
    case 'icon-select':
      return (
        <IconSelectField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      )
    case 'color-select':
      return (
        <ColorSelectField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      )
    case 'palette-editor': {
      const paletteLabel = typeof field.label === 'object' ? (field.label[lang] ?? field.label.en ?? '') : field.label ?? ''
      return (
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">{paletteLabel}</span>
          <PaletteEditor
            value={(value as string) ?? (field.default as string) ?? ''}
            onChange={(v) => onConfigChange({ [fieldKey]: v })}
          />
        </div>
      )
    }
    case 'choice-order':
      return (
        <ChoiceOrderField
          fieldKey={fieldKey}
          field={field}
          value={value}
          columns={columns}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
          rows={rows}
        />
      )
    default:
      return null
  }
}

/**
 * Drag the ANSWERS of a survey question into an explicit order.
 *
 * The stored value is a list of answer codes. Codes the data has but the list
 * does not are appended in declared order rather than dropped: the order is
 * saved in a widget while the data can gain an answer afterwards, and silently
 * hiding a real response would be worse than an imperfect order.
 */
function ChoiceOrderField({
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const choices = useMemo(() => {
    const colId = field.columnField ? (config[field.columnField] as string | undefined) : undefined
    if (!colId) return []
    const schema = inferSurveySchema(columns, rows ?? [])
    const question = schema.questions.find(q => questionColumns(q).includes(colId))
    return question ? questionChoices(schema, question) : []
  }, [field.columnField, config, columns, rows])

  const ordered = useMemo(() => {
    const saved = (value as string[] | undefined) ?? []
    const known = new Set(choices.map(c => c.name))
    const head = saved.filter(code => known.has(code))
    const rest = choices.map(c => c.name).filter(code => !head.includes(code))
    return [...head, ...rest]
  }, [value, choices])

  const labelOf = useMemo(() => {
    const map = new Map(choices.map(c => [c.name, localized(c.label, lang) || c.name]))
    return (code: string) => map.get(code) ?? code
  }, [choices, lang])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const from = ordered.indexOf(String(active.id))
      const to = ordered.indexOf(String(over.id))
      if (from < 0 || to < 0) return
      onConfigChange({ [fieldKey]: arrayMove(ordered, from, to) })
    },
    [ordered, fieldKey, onConfigChange],
  )

  if (ordered.length < 2) return null

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ordered} strategy={verticalListSortingStrategy}>
          <div className="max-h-[200px] overflow-y-auto overscroll-contain rounded-md border divide-y divide-border">
            {ordered.map((code, i) => (
              <SortableColumnRow key={code} id={code} index={i} label={labelOf(code)} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <p className="text-[10px] text-muted-foreground">{t('survey.choice_order_hint')}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Multi column-select (checkbox list)
// ---------------------------------------------------------------------------

function MultiColumnSelect({
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
      c => displayColumnName(c).toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    )
  }, [filtered, search])

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
        .map(displayColumnName)
    }
    return filtered.filter(c => selected.includes(c.id)).map(displayColumnName)
  }, [filtered, selected, field.orderable])

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
                  <span className="truncate" title={col.name}>{displayColumnName(col)}</span>
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
  const { t } = useTranslation()
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
                label={displayColumnName(byId.get(id)!)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

function SortableColumnRow({ id, index, label }: { id: string; index: number; label: string }) {
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

function SingleColumnSelect({
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
      c => displayColumnName(c).toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    )
  }, [filtered, search])

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-8 w-full items-center justify-between rounded-md border px-3 text-xs hover:bg-accent/50 transition-colors"
          >
            <span className={cn('truncate', !currentCol && 'text-muted-foreground')}>
              {currentCol ? displayColumnName(currentCol) : t('common.none')}
            </span>
            <ChevronsUpDown size={12} className="ml-1 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2 bg-popover" align="start">
          {filtered.length > 5 && (
            <SearchInput
              value={search}
              onChange={setSearch}
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
                  <span className="truncate" title={col.name}>{displayColumnName(col)}</span>
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

function ColumnValueSelect({
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
      if (raw != null) seen.add(String(raw))
    }
    return Array.from(seen).sort()
  }, [columnFieldId, rows])

  // Server mode: `rows` is empty (the browser never holds the dataset), so the
  // distinct values must be fetched server-side. Front-only uses localValues.
  // Tagged with the column id so a result for a previous column is never shown.
  const [serverValues, setServerValues] = useState<{ colId: string; values: string[] }>({ colId: '', values: [] })
  const needsServer = isServerMode() && !!datasetFileId && !!columnFieldId && (!rows || rows.length === 0)
  useEffect(() => {
    if (!needsServer) return
    let cancelled = false
    fetchColumnDistinct(datasetFileId!, columnFieldId!, { limit: 500 })
      .then((res) => { if (!cancelled) setServerValues({ colId: columnFieldId!, values: res.values }) })
      .catch(() => { if (!cancelled) setServerValues({ colId: columnFieldId!, values: [] }) })
    return () => { cancelled = true }
  }, [needsServer, datasetFileId, columnFieldId])

  const uniqueValues = localValues.length > 0
    ? localValues
    : needsServer && serverValues.colId === columnFieldId
      ? serverValues.values
      : []

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

// ---------------------------------------------------------------------------
// Select (enum options)
// ---------------------------------------------------------------------------

function SelectField({
  fieldKey,
  field,
  value,
  columns,
  lang,
  config,
  onConfigChange,
  rows,
}: FieldRendererProps) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? ''

  // The survey question the filtered field is about, when it declares one.
  // Inferred from the same data the renderer uses, so the offered charts and
  // the drawn chart cannot disagree.
  const surveyQuestion = useMemo(() => {
    const key = field.filterOptionsBySurveyQuestion
    if (!key) return null
    const colId = config[key] as string | undefined
    if (!colId) return null
    const schema = inferSurveySchema(columns, rows ?? [])
    return schema.questions.find(q => questionColumns(q).includes(colId)) ?? null
  }, [field.filterOptionsBySurveyQuestion, config, columns, rows])

  const visibleOptions = useMemo(() => {
    const allOptions = field.options ?? []
    // Charts the selected QUESTION supports. Offering the rest and quietly
    // substituting a default was the confusing part: the panel said "Pie" while
    // the panel below drew bars, so the fallback read as the chosen answer.
    if (field.filterOptionsBySurveyQuestion) {
      if (!surveyQuestion) return allOptions
      const allowed = new Set<string>(availableCharts(surveyQuestion))
      return allOptions.filter(opt => allowed.has(opt.value))
    }
    if (!field.filterOptionsByColumn) return allOptions
    const colId = config[field.filterOptionsByColumn] as string | undefined
    if (!colId) return allOptions
    const col = columns.find(c => c.id === colId)
    if (!col) return allOptions
    const isNumeric = col.type === 'number'
    return allOptions.filter(opt => {
      if (!opt.onlyForColumnType) return true
      return opt.onlyForColumnType === (isNumeric ? 'numeric' : 'categorical')
    })
  }, [field.options, field.filterOptionsByColumn, field.filterOptionsBySurveyQuestion, surveyQuestion, config, columns])

  // Auto-reset when current value is not in visible options
  useEffect(() => {
    if (visibleOptions.length > 0 && !visibleOptions.some(o => o.value === current)) {
      onConfigChange({ [fieldKey]: visibleOptions[0].value })
    }
  }, [visibleOptions, current, fieldKey, onConfigChange])

  const handleChange = useCallback((v: string) => {
    const changes: Record<string, unknown> = { [fieldKey]: v }
    // Swap paired config values (e.g. X/Y column + labels) when the value actually changes.
    if (field.swapFieldsOnChange && v !== current) {
      for (const [a, b] of field.swapFieldsOnChange) {
        changes[a] = config[b]
        changes[b] = config[a]
      }
    }
    onConfigChange(changes)
  }, [fieldKey, field.swapFieldsOnChange, current, config, onConfigChange])

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Select value={current} onValueChange={handleChange}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {visibleOptions.map(opt => (
            <SelectItem key={opt.value} value={opt.value}>
              {field.optionPreview === 'palette' ? (
                <span className="flex items-center gap-2">
                  <PaletteSwatches palette={CHART_PALETTES[opt.value]} />
                  {opt.label[lang] ?? opt.label.en}
                </span>
              ) : (
                opt.label[lang] ?? opt.label.en
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function PaletteSwatches({ palette }: { palette?: string[] }) {
  if (!palette) return null
  return (
    <span className="flex h-3.5 overflow-hidden rounded-sm border border-border/40">
      {palette.slice(0, 8).map((c, i) => (
        <span key={i} className="w-2" style={{ backgroundColor: c }} />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Multi-select (checkbox list in popover)
// ---------------------------------------------------------------------------

function MultiSelectField({
  fieldKey,
  field,
  value,
  columns,
  lang,
  config,
  onConfigChange,
}: FieldRendererProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  // Filter options by the type of a referenced column (e.g. hide numeric-only stats for categorical data).
  const options = useMemo(() => {
    const all = field.options ?? []
    if (!field.filterOptionsByColumn) return all
    const colId = config[field.filterOptionsByColumn] as string | undefined
    if (!colId) return all
    const col = columns.find(c => c.id === colId)
    if (!col) return all
    const isNumeric = col.type === 'number'
    return all.filter(opt => !opt.onlyForColumnType || opt.onlyForColumnType === (isNumeric ? 'numeric' : 'categorical'))
  }, [field.options, field.filterOptionsByColumn, config, columns])

  const defaultValues = field.defaultAll
    ? options.map(o => o.value)
    : Array.isArray(field.default)
      ? (field.default as string[])
      : []
  const selected = (value as string[] | undefined) ?? defaultValues

  // Drop any selected values that are no longer available (e.g. after switching to a categorical column).
  useEffect(() => {
    const allowed = new Set(options.map(o => o.value))
    if (selected.some(v => !allowed.has(v))) {
      onConfigChange({ [fieldKey]: selected.filter(v => allowed.has(v)) })
    }
  }, [options, selected, fieldKey, onConfigChange])

  const toggle = useCallback(
    (optValue: string) => {
      const next = selected.includes(optValue)
        ? selected.filter(v => v !== optValue)
        : [...selected, optValue]
      onConfigChange({ [fieldKey]: next })
    },
    [fieldKey, selected, onConfigChange],
  )

  const selectAll = useCallback(() => {
    onConfigChange({ [fieldKey]: options.map(o => o.value) })
  }, [fieldKey, options, onConfigChange])

  const selectNone = useCallback(() => {
    onConfigChange({ [fieldKey]: [] })
  }, [fieldKey, onConfigChange])

  const selectedLabels = useMemo(
    () => options.filter(o => selected.includes(o.value)).map(o => o.label[lang] ?? o.label.en ?? o.value),
    [options, selected, lang],
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
              total={options.length}
              className="text-muted-foreground"
            />
            <ChevronsUpDown size={12} className="ml-1 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2 bg-popover" align="start">
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
            {options.map(opt => {
              const isSelected = selected.includes(opt.value)
              return (
                <button
                  key={opt.value}
                  onClick={() => toggle(opt.value)}
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
                  <span className="truncate">{opt.label[lang] ?? opt.label.en}</span>
                </button>
              )
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

function NumberField({
  fieldKey,
  field,
  value,
  lang,
  config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const numValue = (value as number | undefined) ?? (field.default as number | undefined) ?? 0
  const [localText, setLocalText] = useState<string>(String(numValue))

  // Sync local text when external value changes (e.g. reset, undo)
  useEffect(() => {
    setLocalText(String(numValue))
  }, [numValue])

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Input
        type="number"
        className="h-8 text-xs"
        value={localText}
        min={field.min}
        max={field.max}
        onChange={e => {
          const raw = e.target.value
          setLocalText(raw)
          if (raw !== '' && !isNaN(Number(raw))) {
            onConfigChange({ [fieldKey]: Number(raw) })
          }
        }}
        onBlur={() => {
          // Restore to current value if left empty
          if (localText === '' || isNaN(Number(localText))) {
            setLocalText(String(numValue))
          }
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Boolean (toggle checkbox)
// ---------------------------------------------------------------------------

function BooleanField({
  fieldKey,
  field,
  value,
  lang,
  config: _config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const checked = (value as boolean | undefined) ?? (field.default as boolean | undefined) ?? false

  return (
    // data-boolean-field lets a section pull consecutive checkboxes together
    // without tightening fields that carry their own labelled input.
    <div data-boolean-field className={cn('flex flex-col', field.row && 'justify-end')}>
      <button
        onClick={() => onConfigChange({ [fieldKey]: !checked })}
        // h-8 matched a labelled input's control height, but a checkbox has no
        // label above it — the extra height read as padding around the row.
        // Kept full height inside a `row` group so it still aligns with the
        // input it sits beside.
        className={cn('flex items-center gap-2 text-xs', field.row ? 'h-8' : 'h-6')}
      >
        <div
          className={cn(
            'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
            checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30',
          )}
        >
          {checked && <Check size={10} />}
        </div>
        <span>{field.label[lang] ?? field.label.en}</span>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// String
// ---------------------------------------------------------------------------

function StringField({
  fieldKey,
  field,
  value,
  lang,
  config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? ''

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Input
        className="h-8 text-xs"
        value={current}
        onChange={e => onConfigChange({ [fieldKey]: e.target.value })}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Icon select (Lucide icon picker)
// ---------------------------------------------------------------------------

const CURATED_ICONS = [
  'Activity', 'AlertTriangle', 'BarChart3', 'Beaker', 'Brain', 'Calculator',
  'Calendar', 'CheckCircle', 'Clock', 'Crosshair', 'DollarSign', 'Droplet',
  'Eye', 'FileText', 'Flame', 'Gauge', 'Heart', 'HeartPulse', 'Hospital',
  'Layers', 'LineChart', 'Map', 'Microscope', 'Moon', 'Percent', 'PieChart',
  'Pill', 'Scale', 'Shield', 'Sigma', 'Stethoscope', 'Sun', 'Syringe',
  'Target', 'TestTube', 'Thermometer', 'Timer', 'TrendingDown', 'TrendingUp',
  'User', 'Users', 'Zap',
]

function getLucideIcon(name: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[name]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

function IconSelectField({
  fieldKey,
  field,
  value,
  lang,
  config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? 'Activity'
  const isNone = current === '__none__'
  const CurrentIcon = isNone ? Ban : getLucideIcon(current)

  const filtered = useMemo(() => {
    if (!search.trim()) return CURATED_ICONS
    const q = search.toLowerCase()
    return CURATED_ICONS.filter(name => name.toLowerCase().includes(q))
  }, [search])

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-8 items-center gap-2 rounded-md border px-3 text-xs hover:bg-accent/50 transition-colors"
          >
            {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
            <CurrentIcon size={14} className={isNone ? 'text-muted-foreground/50' : undefined} />
            <span className="text-muted-foreground">{isNone ? t('common.none') : current}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" align="start">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search icons..."
            size="dense"
            className="mb-2"
          />
          <ScrollArea className="max-h-[200px]">
            <div className="grid grid-cols-6 gap-1">
              {/* None option */}
              <button
                onClick={() => {
                  onConfigChange({ [fieldKey]: '__none__' })
                  setOpen(false)
                }}
                title={t('common.none')}
                className={cn(
                  'flex size-8 items-center justify-center rounded transition-colors',
                  isNone
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent text-muted-foreground hover:text-foreground',
                )}
              >
                <Ban size={16} />
              </button>
              {filtered.map(name => {
                const Icon = getLucideIcon(name)
                const isSelected = name === current
                return (
                  <button
                    key={name}
                    onClick={() => {
                      onConfigChange({ [fieldKey]: name })
                      setOpen(false)
                    }}
                    title={name}
                    className={cn(
                      'flex size-8 items-center justify-center rounded transition-colors',
                      isSelected
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-accent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon size={16} />
                  </button>
                )
              })}
            </div>
            {filtered.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">No icons found</p>
            )}
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Color select (palette picker — compact popover)
// ---------------------------------------------------------------------------

function ColorSelectField({
  fieldKey,
  field,
  value,
  lang,
  config: _config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? 'blue'

  const specialOptions = useMemo(() => {
    if (!field.options) return undefined
    return field.options.map(opt => ({
      value: opt.value as string,
      label: opt.label as { en: string; fr: string },
    }))
  }, [field.options])

  const fieldLabel = typeof field.label === 'object' ? (field.label[lang] ?? field.label.en ?? '') : field.label ?? ''

  return (
    <ColorPickerPopover
      value={current}
      onChange={v => onConfigChange({ [fieldKey]: v })}
      specialOptions={specialOptions}
      label={fieldLabel}
    />
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The hint shown beside each option in a column picker.
 *
 * Defaults to the column's storage type, which is what someone choosing a
 * column to plot wants. A plugin can ask for `survey` instead, and get the type
 * of the QUESTION the column belongs to — "number" says nothing about a
 * questionnaire, and a multiple-choice question spans several columns, which no
 * storage type can express.
 */
function useColumnHint(
  field: PluginConfigField,
  columns: DatasetColumn[],
  rows: Record<string, unknown>[] | undefined,
): (col: DatasetColumn) => string {
  const { t } = useTranslation()
  const schema = useMemo(
    () => (field.optionHint === 'survey' ? inferSurveySchema(columns, rows ?? []) : null),
    [field.optionHint, columns, rows],
  )
  return useCallback(
    (col: DatasetColumn) => {
      if (!schema) return col.type
      const question = schema.questions.find(q => questionColumns(q).includes(col.id))
      return question ? questionKindLabel(question, t) : col.type
    },
    [schema, t],
  )
}

function filterColumns(
  columns: DatasetColumn[],
  filter?: 'numeric' | 'categorical',
): DatasetColumn[] {
  if (!filter) return columns
  if (filter === 'numeric') return columns.filter(c => c.type === 'number')
  // categorical
  return columns.filter(c => c.type === 'string' || c.type === 'boolean')
}
