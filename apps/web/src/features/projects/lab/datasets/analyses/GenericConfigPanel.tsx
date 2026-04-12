import { useCallback, useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Search, Puzzle, ChevronsUpDown, Info, Ban, ChevronRight } from 'lucide-react'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { ColorPickerPopover } from '@/components/ui/color-picker-popover'
import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'

interface GenericConfigPanelProps {
  schema: Record<string, PluginConfigField>
  config: Record<string, unknown>
  columns: DatasetColumn[]
  onConfigChange: (changes: Record<string, unknown>) => void
  /** Data rows — needed for column-value-select fields. */
  rows?: Record<string, unknown>[]
}

export function GenericConfigPanel({
  schema,
  config,
  columns,
  onConfigChange,
  rows,
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

  // Auto-select first matching column for non-optional single column-select fields
  useEffect(() => {
    if (columns.length === 0) return
    const changes: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(schema)) {
      if (field.type !== 'column-select' || field.optional || field.multi) continue
      if (config[key] != null && config[key] !== '') continue
      const filtered = filterColumns(columns, field.filter)
      if (filtered.length > 0) changes[key] = filtered[0].id
    }
    if (Object.keys(changes).length > 0) onConfigChange(changes)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.length])

  // Filter out fields whose visibleWhen condition is not met
  const visibleEntries = Object.entries(schema).filter(([, field]) => {
    if (!field.visibleWhen) return true
    const conditions = Array.isArray(field.visibleWhen) ? field.visibleWhen : [field.visibleWhen]
    return conditions.every(cond => {
      const depValue = configWithDefaults[cond.field]
      if (cond.notEmpty) return depValue != null && depValue !== '' && depValue !== undefined
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

  // Build sections: group consecutive groups by their section label
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
        />
      ) : (
        <div key={group.keys.join('-')} className={cn('grid gap-4', allBoolean && '-mt-1')} style={{ gridTemplateColumns: `repeat(${group.keys.length}, minmax(0, 1fr))` }}>
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
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors">
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-2">
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
            <TooltipContent side="top" className="max-w-56">
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
}

function FieldRenderer({ fieldKey, field, value, columns, lang, config, onConfigChange, rows }: FieldRendererProps) {
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
          columns={columns}
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
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const filtered = filterColumns(columns, field.filter)
  const current = (value as string | undefined) ?? ''
  const currentCol = filtered.find(c => c.id === current)

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

  const searchFiltered = useMemo(() => {
    if (!search.trim()) return filtered
    const q = search.toLowerCase()
    return filtered.filter(c => c.name.toLowerCase().includes(q))
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
              {currentCol ? currentCol.name : t('common.none')}
            </span>
            <ChevronsUpDown size={12} className="ml-1 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2 bg-popover" align="start">
          {filtered.length > 5 && (
            <div className="relative mb-2">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('common.search')}
                className="h-7 pl-7 text-xs"
              />
            </div>
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
}: FieldRendererProps) {
  const { t } = useTranslation()
  const columnFieldId = config[field.columnField ?? ''] as string | undefined
  const current = (value as string | undefined) ?? ''

  const uniqueValues = useMemo(() => {
    if (!columnFieldId || !rows) return []
    const seen = new Set<string>()
    for (const row of rows) {
      const raw = row[columnFieldId]
      if (raw != null) seen.add(String(raw))
    }
    return Array.from(seen).sort()
  }, [columnFieldId, rows])

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
              {val}
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
}: Omit<FieldRendererProps, 'rows'>) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? ''

  // Filter options by column type if configured
  const visibleOptions = useMemo(() => {
    const allOptions = field.options ?? []
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
  }, [field.options, field.filterOptionsByColumn, config, columns])

  // Auto-reset when current value is not in visible options
  useEffect(() => {
    if (visibleOptions.length > 0 && !visibleOptions.some(o => o.value === current)) {
      onConfigChange({ [fieldKey]: visibleOptions[0].value })
    }
  }, [visibleOptions, current, fieldKey, onConfigChange])

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} config={config} lang={lang} />
      <Select value={current} onValueChange={v => onConfigChange({ [fieldKey]: v })}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {visibleOptions.map(opt => (
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
    <div className={cn('flex flex-col', field.row && 'justify-end')}>
      <button
        onClick={() => onConfigChange({ [fieldKey]: !checked })}
        className="flex h-8 items-center gap-2 text-xs"
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
            <CurrentIcon size={14} className={isNone ? 'text-muted-foreground/50' : undefined} />
            <span className="text-muted-foreground">{isNone ? t('common.none') : current}</span>
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
  config,
  onConfigChange,
}: Omit<FieldRendererProps, 'columns'>) {
  const current = (value as string | undefined) ?? (field.default as string | undefined) ?? 'blue'

  // Build special options from field.options (e.g. "auto", "none")
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

function filterColumns(
  columns: DatasetColumn[],
  filter?: 'numeric' | 'categorical',
): DatasetColumn[] {
  if (!filter) return columns
  if (filter === 'numeric') return columns.filter(c => c.type === 'number')
  // categorical
  return columns.filter(c => c.type === 'string' || c.type === 'boolean')
}
