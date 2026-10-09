import { useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { inferSurveySchema } from '@/lib/survey/survey-infer'
import { questionColumns, questionChoices } from '@/lib/survey/survey-schema'
import { PaletteEditor } from '@/components/ui/palette-editor'
import type { DatasetColumn, LocalizedString } from '@/types'
import type { PluginConfigField } from '@/types/plugin'
import { applyConfigDefaults, conditionsHold } from './config-conditions'
import { useServerColumnDistinct } from './use-server-column-distinct'
import { FieldLabel, type FieldRendererProps } from './config-panel-field-label'
import { MultiColumnSelect, SortableColumnRow, SingleColumnSelect, ColumnValueSelect } from './config-panel-column-fields'
import { SelectField, MultiSelectField, NumberField, BooleanField, StringField, IconSelectField, ColorSelectField } from './config-panel-input-fields'

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
  /** Renders a `dataset-select` field (warehouse scope only), on the same terms:
   *  the host owns the picker so this panel keeps no dataset-store dependency. */
  renderDatasetField?: (fieldKey: string, field: PluginConfigField) => React.ReactNode
}

export function GenericConfigPanel({
  schema,
  config,
  columns,
  onConfigChange,
  rows,
  datasetFileId,
  renderConceptField,
  renderDatasetField,
}: GenericConfigPanelProps) {
  const { i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'

  const configWithDefaults = useMemo(() => applyConfigDefaults(config, schema), [config, schema])

  const visibleEntries = Object.entries(schema).filter(([, field]) =>
    !field.visibleWhen || conditionsHold(field.visibleWhen, configWithDefaults))

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
          renderDatasetField={renderDatasetField}
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
            renderDatasetField={renderDatasetField}
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
                renderDatasetField={renderDatasetField}
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
              renderDatasetField={renderDatasetField}
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
              renderDatasetField={renderDatasetField}
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

function FieldRenderer({ fieldKey, field, value, columns, lang, config, onConfigChange, rows, datasetFileId, renderConceptField, renderDatasetField }: FieldRendererProps) {
  switch (field.type) {
    // Warehouse-only: the host supplies the picker, so this panel stays free of
    // any OMOP dependency.
    case 'concept-select':
      return renderConceptField ? renderConceptField(fieldKey, field) : null
    case 'dataset-select':
      return renderDatasetField ? renderDatasetField(fieldKey, field) : null
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
          renderDatasetField={renderDatasetField}
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
          datasetFileId={datasetFileId}
        />
      )
    default:
      return null
  }
}

/**
 * Drag the ANSWERS of a survey question — or, with `choices: 'column-values'`,
 * the distinct values of a column — into an explicit order.
 *
 * The stored value is a list of codes. Codes the data has but the list does not
 * are appended rather than dropped: the order is saved in a widget while the data
 * can gain a value afterwards, and silently hiding it would be worse than an
 * imperfect order.
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
  datasetFileId,
}: FieldRendererProps) {
  const { t } = useTranslation()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const columnKey = field.columnFieldWhen?.find(c => conditionsHold(c.when, config))?.columnField ?? field.columnField
  const colId = columnKey ? (config[columnKey] as string | undefined) : undefined
  const fromColumn = field.choices === 'column-values'

  // Alphabetical, as the server's distinct endpoint returns them, so the list
  // starts the same in both modes.
  const localValues = useMemo(() => {
    if (!fromColumn || !colId || !rows) return []
    const seen = new Set<string>()
    for (const row of rows) {
      const raw = row[colId]
      if (raw == null || raw === '') continue
      seen.add(String(raw))
    }
    return Array.from(seen).sort()
  }, [fromColumn, colId, rows])
  const serverValues = useServerColumnDistinct(fromColumn ? colId : undefined, rows, datasetFileId)

  const choices = useMemo<{ name: string; label: LocalizedString | string }[]>(() => {
    if (!colId) return []
    if (fromColumn) return (localValues.length > 0 ? localValues : serverValues).map(name => ({ name, label: name }))
    const schema = inferSurveySchema(columns, rows ?? [])
    const question = schema.questions.find(q => questionColumns(q).includes(colId))
    return question ? questionChoices(schema, question) : []
  }, [colId, fromColumn, localValues, serverValues, columns, rows])

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
      <p className="text-[10px] text-muted-foreground">
        {fromColumn ? t('analyses.category_order_hint') : t('survey.choice_order_hint')}
      </p>
    </div>
  )
}
