import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/analysis-plugin'

interface GenericConfigPanelProps {
  schema: Record<string, PluginConfigField>
  config: Record<string, unknown>
  columns: DatasetColumn[]
  onConfigChange: (changes: Record<string, unknown>) => void
}

export function GenericConfigPanel({
  schema,
  config,
  columns,
  onConfigChange,
}: GenericConfigPanelProps) {
  const { i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'

  return (
    <div className="space-y-4 p-3">
      {Object.entries(schema).map(([key, field]) => (
        <FieldRenderer
          key={key}
          fieldKey={key}
          field={field}
          value={config[key]}
          columns={columns}
          lang={lang}
          onConfigChange={onConfigChange}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface FieldRendererProps {
  fieldKey: string
  field: PluginConfigField
  value: unknown
  columns: DatasetColumn[]
  lang: 'en' | 'fr'
  onConfigChange: (changes: Record<string, unknown>) => void
}

function FieldRenderer({ fieldKey, field, value, columns, lang, onConfigChange }: FieldRendererProps) {
  switch (field.type) {
    case 'column-select':
      return field.multi ? (
        <MultiColumnSelect
          fieldKey={fieldKey}
          field={field}
          value={value}
          columns={columns}
          lang={lang}
          onConfigChange={onConfigChange}
        />
      ) : (
        <SingleColumnSelect
          fieldKey={fieldKey}
          field={field}
          value={value}
          columns={columns}
          lang={lang}
          onConfigChange={onConfigChange}
        />
      )
    case 'select':
      return (
        <SelectField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
          onConfigChange={onConfigChange}
        />
      )
    case 'number':
      return (
        <NumberField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
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
          onConfigChange={onConfigChange}
        />
      )
    default:
      return null
  }
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
  onConfigChange,
}: FieldRendererProps) {
  const { t } = useTranslation()
  const filtered = filterColumns(columns, field.filter)
  const selected = (value as string[] | undefined) ?? (field.defaultAll ? filtered.map(c => c.id) : [])

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

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{field.label[lang] ?? field.label.en}</Label>
        <div className="flex items-center gap-1">
          <button onClick={selectAll} className="text-[10px] text-muted-foreground hover:text-foreground">
            {t('common.select_all')}
          </button>
          <span className="text-[10px] text-muted-foreground">/</span>
          <button onClick={selectNone} className="text-[10px] text-muted-foreground hover:text-foreground">
            {t('common.select_none')}
          </button>
        </div>
      </div>
      <ScrollArea className="max-h-[200px]">
        <div className="space-y-0.5">
          {filtered.map(col => {
            const isSelected = selected.includes(col.id)
            return (
              <button
                key={col.id}
                onClick={() => toggle(col.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-xs transition-colors',
                  isSelected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50',
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
                <span className="truncate">{col.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{col.type}</span>
              </button>
            )
          })}
        </div>
      </ScrollArea>
      <p className="text-[10px] text-muted-foreground">
        {selected.length} / {filtered.length} {t('datasets.analysis_selected')}
      </p>
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
  onConfigChange,
}: FieldRendererProps) {
  const { t } = useTranslation()
  const filtered = filterColumns(columns, field.filter)
  const current = (value as string | undefined) ?? ''

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label[lang] ?? field.label.en}</Label>
      <Select
        value={current || '__none__'}
        onValueChange={v => onConfigChange({ [fieldKey]: v === '__none__' ? undefined : v })}
      >
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.optional && (
            <SelectItem value="__none__">{t('common.none')}</SelectItem>
          )}
          {filtered.map(col => (
            <SelectItem key={col.id} value={col.id}>
              {col.name}
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
  lang,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? ''

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label[lang] ?? field.label.en}</Label>
      <Select value={current} onValueChange={v => onConfigChange({ [fieldKey]: v })}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map(opt => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label[lang] ?? opt.label.en}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const current = (value as number | undefined) ?? (field.default as number | undefined) ?? 0

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label[lang] ?? field.label.en}</Label>
      <Input
        type="number"
        className="h-8 text-xs"
        value={current}
        min={field.min}
        max={field.max}
        onChange={e => onConfigChange({ [fieldKey]: Number(e.target.value) })}
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
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const checked = (value as boolean | undefined) ?? (field.default as boolean | undefined) ?? false

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => onConfigChange({ [fieldKey]: !checked })}
        className="flex items-center gap-2 text-xs"
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
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? ''

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label[lang] ?? field.label.en}</Label>
      <Input
        className="h-8 text-xs"
        value={current}
        onChange={e => onConfigChange({ [fieldKey]: e.target.value })}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterColumns(
  columns: DatasetColumn[],
  filter?: 'numeric' | 'categorical',
): DatasetColumn[] {
  if (!filter) return columns
  if (filter === 'numeric') return columns.filter(c => c.type === 'number')
  // categorical
  return columns.filter(c => c.type === 'string' || c.type === 'boolean')
}
