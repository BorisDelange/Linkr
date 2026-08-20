import { useTranslation } from 'react-i18next'
import { Info, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DebouncedInput } from '@/components/ui/debounced-input'
import { Label } from '@/components/ui/label'
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

export function TextCriteriaForm({ config, onChange, schemaMapping }: TextCriteriaFormProps) {
  const { t } = useTranslation()
  const searches = config.searches ?? []
  const hasTitle = Boolean(schemaMapping?.noteTable?.titleColumn)
  const hasNotes = Boolean(schemaMapping?.noteTable?.textColumn)

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
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.text_label')}</Label>
        {/* Debounced: this writes through to the cohort tree, so a raw onChange
            persisted the whole cohort on every keystroke. */}
        <DebouncedInput
          value={config.label ?? ''}
          onChange={(label) => update({ label })}
          placeholder={t('cohorts.text_label_placeholder')}
          className={INPUT_CLASS}
        />
        <p className="text-[10px] text-muted-foreground">{t('cohorts.text_label_hint')}</p>
      </div>

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
            <button
              type="button"
              onClick={() => updateSearch(index, { exclude: !search.exclude })}
              title={t('cohorts.text_exclude_hint')}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors',
                search.exclude
                  ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 dark:text-red-400'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {t('cohorts.text_not')}
            </button>
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
        size="sm"
        className="h-7 w-full gap-1 text-xs"
        onClick={addSearch}
        disabled={!hasNotes}
      >
        <Plus size={12} />
        {searches.length === 0 ? t('cohorts.text_add_search') : t('cohorts.text_add_field')}
      </Button>

      {searches.length > 1 && (
        <p className="text-[10px] text-muted-foreground">{t('cohorts.text_fields_anded')}</p>
      )}

      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.text_note')}</Label>
        <Textarea
          value={config.description ?? ''}
          onChange={(e) => update({ description: e.target.value })}
          rows={2}
          className="resize-none text-xs"
        />
      </div>
    </div>
  )
}
