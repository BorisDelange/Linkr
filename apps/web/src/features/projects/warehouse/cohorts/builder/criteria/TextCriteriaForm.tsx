import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MultiSelectFilter, type MultiSelectOption } from '@/components/ui/multi-select-filter'
import { queryDataSource } from '@/lib/duckdb/engine'
import { classRelation, has } from '@/lib/schema-classes/relations'
import { Info, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DebouncedInput } from '@/components/ui/debounced-input'
import { FormField } from '@/components/ui/form-field'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { OperatorSeparator } from '../OperatorSeparator'
import type { SchemaMapping, TextCriteriaConfig, TextFieldSearch, TextMatchMode } from '@/types'

interface TextCriteriaFormProps {
  config: TextCriteriaConfig
  onChange: (config: TextCriteriaConfig) => void
  schemaMapping?: SchemaMapping
  /** The database whose note types are offered. */
  dataSourceId?: string
}

/** The note types of the database, most frequent first, with their counts. */
function useNoteTypes(dataSourceId: string | undefined, mapping: SchemaMapping | undefined): MultiSelectOption[] {
  const [options, setOptions] = useState<MultiSelectOption[]>([])
  const note = mapping ? classRelation(mapping, 'note') : undefined
  const relation = has(note, 'note_type') ? note!.name : null
  useEffect(() => {
    if (!dataSourceId || !relation) return
    let cancelled = false
    queryDataSource(dataSourceId, `SELECT CAST(note_type AS VARCHAR) AS note_type, COUNT(*) AS n
FROM ${relation}
WHERE note_type IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC
LIMIT 500`, { origin: 'Cohort builder · note types to filter on' })
      .then((rows) => {
        if (cancelled) return
        setOptions(rows.map((r) => ({ value: String(r.note_type), label: `${String(r.note_type)} (${Number(r.n).toLocaleString()})` })))
      })
      .catch(() => { if (!cancelled) setOptions([]) })
    return () => { cancelled = true }
  }, [dataSourceId, relation])
  return options
}

const MATCH_MODES: TextMatchMode[] = ['contains', 'word', 'regex']

/** DebouncedInput renders a bare <input>, so it carries the Input styling. */
const INPUT_CLASS =
  'h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** Terms are typed as a comma-separated list — the shape a clinician writes.
 *  Except in regex mode, where a comma is part of the syntax: splitting
 *  `\d{2,3}` on it yields two broken patterns that match nothing. */
function parseTerms(raw: string, mode: TextMatchMode): string[] {
  if (mode === 'regex') {
    const term = raw.trim()
    return term ? [term] : []
  }
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** A small on/off chip with its explanation in a tooltip. */
function HintToggle({ pressed, onToggle, hint, className, children }: {
  pressed: boolean
  onToggle: () => void
  hint: string
  className?: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={pressed}
          aria-label={hint}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-bold transition-colors',
            pressed ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'text-muted-foreground hover:bg-accent',
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">{hint}</TooltipContent>
    </Tooltip>
  )
}

export function TextCriteriaForm({ config, onChange, schemaMapping, dataSourceId }: TextCriteriaFormProps) {
  const { t } = useTranslation()
  const searches = config.searches ?? []
  const note = schemaMapping ? classRelation(schemaMapping, 'note') : undefined
  const hasTitle = has(note, 'title')
  const hasNotes = has(note, 'text')
  const noteTypes = useNoteTypes(dataSourceId, schemaMapping)
  // A saved type the database no longer lists stays visible, to be removed.
  const typeOptions: MultiSelectOption[] = [
    ...noteTypes,
    ...(config.noteTypes ?? []).filter((v) => !noteTypes.some((o) => typeof o !== 'string' && o.value === v)),
  ]

  const update = (patch: Partial<TextCriteriaConfig>) => onChange({ ...config, ...patch })

  const updateSearch = (index: number, patch: Partial<TextFieldSearch>) => {
    update({ searches: searches.map((s, i) => (i === index ? { ...s, ...patch } : s)) })
  }

  const addSearch = () => {
    update({
      searches: [...searches, { field: hasTitle && searches.length > 0 ? 'title' : 'text', terms: [] }],
    })
  }

  return (
    <div className="space-y-3">
      <FormField label={t('cohorts.text_label')} hint={t('cohorts.text_label_hint')} hintInTooltip>
        {() => (
          // Debounced: this writes through to the cohort tree, so a raw onChange
          // persisted the whole cohort on every keystroke.
          <DebouncedInput
            value={config.label ?? ''}
            onChange={(label) => update({ label })}
            placeholder={t('cohorts.text_label_placeholder')}
            className={INPUT_CLASS}
          />
        )}
      </FormField>

      {has(note, 'note_type') && (
        <FormField label={t('cohorts.text_note_types')} hint={t('cohorts.text_note_types_hint')} hintInTooltip>
          {() => (
            <MultiSelectFilter
              value={config.noteTypes ?? []}
              options={typeOptions}
              placeholder={t('cohorts.text_note_types_placeholder')}
              onChange={(noteTypes) => update({ noteTypes })}
              popoverWidthClass="w-72"
              selectAllRespectsSearch
              showChevron
              triggerClass="h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
            />
          )}
        </FormField>
      )}

      {!hasNotes && (
        <p className="rounded-md border border-dashed px-2 py-1.5 text-[10px] text-muted-foreground">
          {t('cohorts.text_no_note_table')}
        </p>
      )}

      {searches.map((search, index) => (
        <div key={index}>
          {/* Same AND/OR separator as the criteria tree, with the same
              precedence in the generated SQL. */}
          {index > 0 && (
            <OperatorSeparator
              operator={search.operator ?? 'AND'}
              onToggle={() =>
                updateSearch(index, {
                  operator: (search.operator ?? 'AND') === 'AND' ? 'OR' : 'AND',
                })
              }
            />
          )}
          <div className="space-y-1.5 rounded-md border p-2">
          <div className="flex items-center gap-1.5">
            <HintToggle
              pressed={!!search.exclude}
              onToggle={() => updateSearch(index, { exclude: !search.exclude })}
              hint={t('cohorts.text_exclude_hint')}
              className={cn(
                'uppercase tracking-wide',
                search.exclude && 'bg-red-500/10 text-red-500 hover:bg-red-500/20 dark:text-red-400',
              )}
            >
              {t('cohorts.text_not')}
            </HintToggle>
            <Select
              value={search.field}
              onValueChange={(v) => updateSearch(index, { field: v as 'title' | 'text' })}
            >
              <SelectTrigger size="sm" className="h-7 w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text" className="text-xs">
                  {t('cohorts.text_field_text')}
                </SelectItem>
                <SelectItem value="title" disabled={!hasTitle} className="text-xs">
                  {t('cohorts.text_field_title')}
                </SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={search.mode ?? 'contains'}
              onValueChange={(v) => updateSearch(index, { mode: v as TextMatchMode })}
            >
              <SelectTrigger size="sm" className="h-7 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MATCH_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode} className="text-xs">
                    {t(`cohorts.text_mode_${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground/70 hover:text-muted-foreground">
                  <Info size={12} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72 text-xs">
                {t(`cohorts.text_mode_${search.mode ?? 'contains'}_hint`)}
              </TooltipContent>
            </Tooltip>

            {/* Case and accents ignored by default: a clinical note spells a word
                every way it can. */}
            <div className="ml-2 flex items-center gap-0.5">
              <HintToggle
                pressed={!search.caseSensitive}
                onToggle={() => updateSearch(index, { caseSensitive: !search.caseSensitive })}
                hint={t(search.caseSensitive ? 'cohorts.text_ignore_case_off' : 'cohorts.text_ignore_case_on')}
              >
                A=a
              </HintToggle>
              <HintToggle
                pressed={search.ignoreAccents !== false}
                onToggle={() => updateSearch(index, { ignoreAccents: search.ignoreAccents === false })}
                hint={t(search.ignoreAccents !== false ? 'cohorts.text_ignore_accents_on' : 'cohorts.text_ignore_accents_off')}
              >
                é=e
              </HintToggle>
            </div>

            <button
              type="button"
              onClick={() => update({ searches: searches.filter((_, i) => i !== index) })}
              className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
              aria-label={t('common.remove')}
            >
              <X size={12} />
            </button>
          </div>

          <DebouncedInput
            value={search.terms.join(', ')}
            onChange={(raw) =>
              updateSearch(index, { terms: parseTerms(raw, search.mode ?? 'contains') })
            }
            placeholder={t(
              search.mode === 'regex' ? 'cohorts.text_regex_placeholder' : 'cohorts.text_terms_placeholder',
            )}
            className={`${INPUT_CLASS} font-mono`}
          />
          {search.mode !== 'regex' && search.terms.length <= 1 && (
            <p className="text-[10px] text-muted-foreground">{t('cohorts.text_terms_hint')}</p>
          )}

          {search.terms.length > 1 && (
            <Select
              value={search.anyTerm === false ? 'all' : 'any'}
              onValueChange={(v) => updateSearch(index, { anyTerm: v === 'any' })}
            >
              <SelectTrigger size="sm" className="h-7 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any" className="text-xs">
                  {t('cohorts.text_any_term')}
                </SelectItem>
                <SelectItem value="all" className="text-xs">
                  {t('cohorts.text_all_terms')}
                </SelectItem>
              </SelectContent>
            </Select>
          )}
          </div>
        </div>
      ))}

      <Button
        variant="outline"
        size="sm-tight"
        className="w-full"
        onClick={addSearch}
        disabled={!hasNotes}
      >
        <Plus size={12} />
        {searches.length === 0 ? t('cohorts.text_add_search') : t('cohorts.text_add_field')}
      </Button>

      {searches.length > 1 && (
        <p className="text-[10px] text-muted-foreground">{t('cohorts.text_fields_anded')}</p>
      )}

      <FormField label={t('cohorts.text_note')}>
        {({ id }) => (
          <Textarea
            id={id}
            value={config.description ?? ''}
            onChange={(e) => update({ description: e.target.value })}
            rows={2}
            className="resize-none text-xs"
          />
        )}
      </FormField>
    </div>
  )
}
