import { useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Search, Puzzle, ChevronsUpDown } from 'lucide-react'
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

  // Build effective config with defaults filled in for unset fields
  const configWithDefaults = useMemo(() => {
    const result = { ...config }
    for (const [key, field] of Object.entries(schema)) {
      if (result[key] === undefined && field.default !== undefined) {
        result[key] = field.default
      }
    }
    return result
  }, [config, schema])

  // Filter out fields whose visibleWhen condition is not met
  const visibleEntries = Object.entries(schema).filter(([, field]) => {
    if (!field.visibleWhen) return true
    const depValue = configWithDefaults[field.visibleWhen.field]
    return depValue === field.visibleWhen.value
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

  return (
    <div className="space-y-4 p-3">
      {groups.map((group) =>
        group.keys.length === 1 ? (
          <FieldRenderer
            key={group.keys[0]}
            fieldKey={group.keys[0]}
            field={group.fields[0]}
            value={configWithDefaults[group.keys[0]]}
            columns={columns}
            lang={lang}
            config={configWithDefaults}
            onConfigChange={onConfigChange}
          />
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
              />
            ))}
          </div>
        ),
      )}
    </div>
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
    const label = field.hintWhen.values[depValue]
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
  return (
    <Label className="text-xs flex items-center">
      {field.label[lang] ?? field.label.en}
      {hint && <HintBadge text={hint} />}
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
}

function FieldRenderer({ fieldKey, field, value, columns, lang, config, onConfigChange }: FieldRendererProps) {
  switch (field.type) {
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
    case 'select':
      return field.multi ? (
        <MultiSelectField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      ) : (
        <SelectField
          fieldKey={fieldKey}
          field={field}
          value={value}
          lang={lang}
          config={config}
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
  config,
  onConfigChange,
}: FieldRendererProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
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

  const searchFiltered = useMemo(() => {
    if (!search.trim()) return filtered
    const q = search.toLowerCase()
    return filtered.filter(c => c.name.toLowerCase().includes(q))
  }, [filtered, search])

  const triggerLabel = selected.length === filtered.length
    ? t('common.select_all')
    : selected.length === 0
      ? t('common.select_none')
      : `${selected.length} / ${filtered.length}`

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-8 w-full items-center justify-between rounded-md border px-3 text-xs hover:bg-accent/50 transition-colors"
          >
            <span className="truncate text-muted-foreground">{triggerLabel}</span>
            <ChevronsUpDown size={12} className="ml-1 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2 bg-popover" align="start">
          <div className="relative mb-2">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('common.search')}
              className="h-7 pl-7 text-xs"
            />
          </div>
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
                  <span className="truncate">{col.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/60">{col.type}</span>
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
}: FieldRendererProps) {
  const { t } = useTranslation()
  const filtered = filterColumns(columns, field.filter)
  const current = (value as string | undefined) ?? ''

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
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
  config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? ''

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
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
// Multi-select (checkbox list in popover)
// ---------------------------------------------------------------------------

function MultiSelectField({
  fieldKey,
  field,
  value,
  lang,
  config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const options = field.options ?? []
  const defaultValues = field.defaultAll
    ? options.map(o => o.value)
    : Array.isArray(field.default)
      ? (field.default as string[])
      : []
  const selected = (value as string[] | undefined) ?? defaultValues

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

  const triggerLabel = selected.length === options.length
    ? t('common.select_all')
    : selected.length === 0
      ? t('common.select_none')
      : `${selected.length} / ${options.length}`

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-8 w-full items-center justify-between rounded-md border px-3 text-xs hover:bg-accent/50 transition-colors"
          >
            <span className="truncate text-muted-foreground">{triggerLabel}</span>
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
  const current = (value as number | undefined) ?? (field.default as number | undefined) ?? 0

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
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
  config: _config,
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
      <FieldLabel field={field} config={config} lang={lang} />
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
  config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? 'blue'

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
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
