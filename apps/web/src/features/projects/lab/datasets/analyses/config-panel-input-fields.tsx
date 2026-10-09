import { useCallback, useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Puzzle, ChevronsUpDown, Ban } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { firstMatchOnEnter } from '@/components/ui/search-enter'
import { SelectionTriggerLabel } from '@/components/ui/selection-trigger-label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { localizedRaw, setLocalizedOptional } from '@/lib/localized'
import { inferSurveySchema } from '@/lib/survey/survey-infer'
import { questionColumns } from '@/lib/survey/survey-schema'
import { availableCharts } from './survey-charts'
import { ColorPickerPopover } from '@/components/ui/color-picker-popover'
import { CHART_PALETTES } from '@/lib/plugins/shared-styles'
import type { LocalizedString } from '@/types'
import { FieldLabel, type FieldRendererProps } from './config-panel-field-label'

// ---------------------------------------------------------------------------
// Select (enum options)
// ---------------------------------------------------------------------------

export function SelectField({
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
    // Re-seed companion fields whose sensible default depends on the chosen option.
    if (field.setFieldsOnChange && v !== current) {
      Object.assign(changes, field.setFieldsOnChange[v] ?? {})
    }
    onConfigChange(changes)
  }, [fieldKey, field.swapFieldsOnChange, field.setFieldsOnChange, current, config, onConfigChange])

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

export function MultiSelectField({
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

export function NumberField({
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

export function BooleanField({
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
        // Same size and weight as a <Label>: a checkbox's text IS its field label,
        // so a lighter weight made it read as smaller than the ones above it.
        className={cn('flex items-center gap-2 text-xs font-medium', field.row ? 'h-8' : 'h-6')}
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

export function StringField({
  fieldKey,
  field,
  value,
  lang,
  config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const { t } = useTranslation()
  const stored = (value ?? field.default) as LocalizedString | string | undefined
  const current = field.localized ? localizedRaw(stored, lang) : ((stored as string | undefined) ?? '')

  return (
    <div className="space-y-1.5">
      {field.localized ? (
        <div className="flex items-center justify-between gap-2">
          <FieldLabel field={field} config={config} lang={lang} />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="cursor-help uppercase">
                  {lang}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-56">
                {lang === 'fr' ? t('analyses.localized_field_hint_fr') : t('analyses.localized_field_hint_en')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : (
        <FieldLabel field={field} config={config} lang={lang} />
      )}
      <Input
        className="h-8 text-xs"
        value={current}
        onChange={e => onConfigChange({
          [fieldKey]: field.localized ? setLocalizedOptional(value as LocalizedString | string | undefined, lang, e.target.value) : e.target.value,
        })}
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

export function IconSelectField({
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
            onEnter={() => {
              const first = firstMatchOnEnter(search, filtered)
              if (!first) return
              onConfigChange({ [fieldKey]: first })
              setOpen(false)
            }}
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

export function ColorSelectField({
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
