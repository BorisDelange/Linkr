import { useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Search, Puzzle } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
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
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'

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
    case 'icon-select':
      return (
        <IconSelectField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
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
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? 'Activity'
  const CurrentIcon = getLucideIcon(current)

  const filtered = useMemo(() => {
    if (!search.trim()) return CURATED_ICONS
    const q = search.toLowerCase()
    return CURATED_ICONS.filter(name => name.toLowerCase().includes(q))
  }, [search])

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label[lang] ?? field.label.en}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-8 items-center gap-2 rounded-md border px-3 text-xs hover:bg-accent/50 transition-colors"
          >
            <CurrentIcon size={14} />
            <span className="text-muted-foreground">{current}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" align="start">
          <div className="relative mb-2">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search icons..."
              className="h-7 pl-7 text-xs"
            />
          </div>
          <ScrollArea className="max-h-[200px]">
            <div className="grid grid-cols-6 gap-1">
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
// Color select (palette picker)
// ---------------------------------------------------------------------------

const COLOR_PALETTE = [
  { name: 'red', bg: 'bg-red-500', ring: 'ring-red-500' },
  { name: 'rose', bg: 'bg-rose-500', ring: 'ring-rose-500' },
  { name: 'amber', bg: 'bg-amber-500', ring: 'ring-amber-500' },
  { name: 'green', bg: 'bg-green-500', ring: 'ring-green-500' },
  { name: 'emerald', bg: 'bg-emerald-500', ring: 'ring-emerald-500' },
  { name: 'cyan', bg: 'bg-cyan-500', ring: 'ring-cyan-500' },
  { name: 'blue', bg: 'bg-blue-500', ring: 'ring-blue-500' },
  { name: 'indigo', bg: 'bg-indigo-500', ring: 'ring-indigo-500' },
  { name: 'violet', bg: 'bg-violet-500', ring: 'ring-violet-500' },
  { name: 'slate', bg: 'bg-slate-500', ring: 'ring-slate-500' },
]

function ColorSelectField({
  fieldKey,
  field,
  value,
  lang,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? 'blue'

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label[lang] ?? field.label.en}</Label>
      <div className="flex flex-wrap gap-1.5">
        {COLOR_PALETTE.map(c => {
          const isSelected = c.name === current
          return (
            <button
              key={c.name}
              onClick={() => onConfigChange({ [fieldKey]: c.name })}
              title={c.name}
              className={cn(
                'size-6 rounded-full transition-all',
                c.bg,
                isSelected && `ring-2 ${c.ring} ring-offset-2 ring-offset-background`,
              )}
            />
          )
        })}
      </div>
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
