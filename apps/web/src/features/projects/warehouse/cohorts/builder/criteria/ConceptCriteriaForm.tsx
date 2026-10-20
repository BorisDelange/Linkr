import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, ChevronRight, X, Plus, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { NumberInput } from '@/components/ui/number-input'
import { FormField } from '@/components/ui/form-field'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { FieldInfo } from '@/components/ui/field-info'
import { MULTI_SELECT_FORM_TRIGGER, MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { columnLabel } from '@/lib/format-helpers'
import { conceptCriterionBoundToStay, listedEventTables } from '@/lib/duckdb/cohort-query'
import { useConceptInfo } from '@/features/projects/warehouse/concepts/concept-info'
import type { CohortLevel, ConceptCriteriaConfig, SchemaMapping, ValueFilter } from '@/types'

interface ConceptCriteriaFormProps {
  config: ConceptCriteriaConfig
  onChange: (config: ConceptCriteriaConfig) => void
  eventTableLabels: string[]
  onOpenConceptPicker?: () => void
  cohortLevel?: CohortLevel
  schemaMapping?: SchemaMapping
  /** The database the concepts are read from, for their details on hover. */
  dataSourceId?: string
}

/** Concepts shown before the list folds behind "Show all". */
const FOLDED_CONCEPTS = 12

/** What a concept's tooltip lists, in this order, when the row has it. */
const INFO_FIELDS = ['concept_name', 'concept_id', 'vocabulary_id', 'concept_code', 'domain_id', 'concept_class_id', 'standard_concept', '_dict_key']

/** A selected concept, its details — terminology, code, label… — on hover. */
function ConceptChip({ id, name, dataSourceId, schemaMapping, onRemove }: {
  id: number
  name: string | undefined
  dataSourceId?: string
  schemaMapping?: SchemaMapping
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [hovered, setHovered] = useState(false)
  const { info, loading } = useConceptInfo(dataSourceId, schemaMapping, id, hovered)
  const rows = info
    ? INFO_FIELDS.filter((f) => info[f] != null && info[f] !== '').map((f) => [f, String(info[f])] as const)
    : [['concept_name', name ?? String(id)], ['concept_id', String(id)]] as const
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip onOpenChange={(open) => { if (open) setHovered(true) }}>
        <TooltipTrigger asChild>
          <Badge variant="secondary" className="gap-1 py-0.5 px-2">
            <span className="truncate max-w-[180px]">{name ?? id}</span>
            <button
              type="button"
              onClick={onRemove}
              aria-label={t('common.remove')}
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20"
            >
              <X className="size-3" />
            </button>
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-0.5">
            {rows.map(([field, value]) => (
              <div key={field} className="flex items-baseline justify-between gap-3">
                <span className="shrink-0 opacity-70">{columnLabel(field)}</span>
                <span className="min-w-0 break-words text-right font-medium">{value}</span>
              </div>
            ))}
            {loading && <p className="opacity-70">{t('common.loading')}</p>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const VALUE_OPERATORS = ['>', '>=', '=', '<=', '<', '!=', 'between'] as const
const COUNT_OPERATORS = ['>=', '>', '=', '<=', '<'] as const

export function ConceptCriteriaForm({ config, onChange, eventTableLabels, onOpenConceptPicker, cohortLevel, schemaMapping, dataSourceId }: ConceptCriteriaFormProps) {
  const { t } = useTranslation()
  const [valueFilterOpen, setValueFilterOpen] = useState((config.valueFilters?.length ?? 0) > 0)
  const [occurrenceOpen, setOccurrenceOpen] = useState(!!config.occurrenceCount)
  const [showAllConcepts, setShowAllConcepts] = useState(false)
  // Absent: every table, ticked; one the mapping no longer has is dropped.
  const searched = (listedEventTables(config) ?? eventTableLabels).filter((l) => eventTableLabels.includes(l))
  const noTable = searched.length === 0
  const unboundToStay = !!cohortLevel && !!schemaMapping && !noTable
    && !conceptCriterionBoundToStay(cohortLevel, schemaMapping, searched)
  const shownConcepts = showAllConcepts ? config.conceptIds : config.conceptIds.slice(0, FOLDED_CONCEPTS)
  const hiddenConcepts = config.conceptIds.length - FOLDED_CONCEPTS

  // Every table ticked is stored as none listed: a table the mapping gains later is searched too.
  const setTables = (next: string[]) => {
    const all = eventTableLabels.every((l) => next.includes(l))
    const rest = { ...config } as ConceptCriteriaConfig & { eventTableLabel?: string }
    delete rest.eventTableLabel
    if (all) delete rest.eventTableLabels
    onChange(all ? rest : { ...rest, eventTableLabels: eventTableLabels.filter((l) => next.includes(l)) })
  }

  const removeConcept = (conceptId: number) => {
    const conceptIds = config.conceptIds.filter((id) => id !== conceptId)
    const conceptNames = { ...config.conceptNames }
    delete conceptNames[conceptId]
    onChange({ ...config, conceptIds, conceptNames })
  }

  const addValueFilter = () => {
    const filters = [...(config.valueFilters ?? []), { operator: '>' as const, value: 0 }]
    onChange({ ...config, valueFilters: filters })
  }

  const updateValueFilter = (index: number, update: Partial<ValueFilter>) => {
    const filters = [...(config.valueFilters ?? [])]
    filters[index] = { ...filters[index], ...update }
    onChange({ ...config, valueFilters: filters })
  }

  const removeValueFilter = (index: number) => {
    const filters = (config.valueFilters ?? []).filter((_, i) => i !== index)
    onChange({ ...config, valueFilters: filters.length > 0 ? filters : undefined })
  }

  return (
    <div className="space-y-3">
      {/* Event tables searched: every one by default */}
      <FormField label={t('cohorts.concept_event_tables')}>
        {() => (
          <MultiSelectFilter
            value={searched}
            options={eventTableLabels}
            placeholder={t('cohorts.concept_event_tables_none')}
            onChange={setTables}
            showChevron
            triggerClass={MULTI_SELECT_FORM_TRIGGER}
            popoverWidthClass="w-64"
          />
        )}
      </FormField>
      {noTable && (
        <p className="flex items-start gap-1.5 text-[10px] text-destructive">
          <AlertCircle size={12} className="mt-px shrink-0" />
          {t('cohorts.concept_event_tables_error')}
        </p>
      )}
      {unboundToStay && (
        <p className="flex items-start gap-1.5 text-[10px] text-warning-foreground">
          <AlertTriangle size={12} className="mt-px shrink-0" />
          {t('cohorts.concept_not_bound_to_stay')}
        </p>
      )}

      {/* Selected concepts + picker button */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label>
            {t('cohorts.concept_selected')} ({config.conceptIds.length})
          </Label>
          {onOpenConceptPicker && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 text-[10px]"
              onClick={onOpenConceptPicker}
            >
              <Search size={10} />
              {t('cohorts.concept_pick')}
            </Button>
          )}
        </div>
        {config.conceptIds.length > 1 && (
          <div className="flex items-center gap-1.5">
            <Select
              value={config.conceptMatch ?? 'any'}
              onValueChange={(v) => onChange({ ...config, conceptMatch: v as 'any' | 'all' })}
            >
              <SelectTrigger className="h-7 w-auto text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any" className="text-xs">{t('cohorts.concept_match_any')}</SelectItem>
                <SelectItem value="all" className="text-xs">{t('cohorts.concept_match_all')}</SelectItem>
              </SelectContent>
            </Select>
            <FieldInfo text={t('cohorts.concept_match_hint')} />
          </div>
        )}
        {config.conceptIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {shownConcepts.map((id) => (
              <ConceptChip
                key={id}
                id={id}
                name={config.conceptNames[id]}
                dataSourceId={dataSourceId}
                schemaMapping={schemaMapping}
                onRemove={() => removeConcept(id)}
              />
            ))}
            {hiddenConcepts > 0 && (
              <button
                type="button"
                onClick={() => setShowAllConcepts((v) => !v)}
                className="px-1 text-[10px] text-muted-foreground hover:text-foreground"
              >
                {showAllConcepts ? t('cohorts.concept_show_less') : t('cohorts.concept_show_all', { count: config.conceptIds.length })}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={onOpenConceptPicker}
            className="w-full rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground/70 transition-colors"
          >
            {t('cohorts.concept_pick')}...
          </button>
        )}
      </div>

      {/* Value filters (collapsible, multiple) */}
      <Collapsible open={valueFilterOpen} onOpenChange={setValueFilterOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
          <ChevronRight className={`size-3.5 transition-transform ${valueFilterOpen ? 'rotate-90' : ''}`} />
          {t('cohorts.concept_value_filter')}
          {(config.valueFilters?.length ?? 0) > 0 && (
            <Badge variant="secondary" className="ml-1 px-1 py-0">
              {config.valueFilters!.length}
            </Badge>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 pl-5 space-y-2">
          {(config.valueFilters ?? []).map((vf, index) => (
            <div key={index} className="flex items-center gap-2">
              <Select
                value={vf.operator}
                onValueChange={(op) => updateValueFilter(index, { operator: op as ValueFilter['operator'] })}
              >
                <SelectTrigger className="h-8 w-20 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VALUE_OPERATORS.map((op) => (
                    <SelectItem key={op} value={op} className="text-xs">
                      {op}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <NumberInput
                integer={false}
                value={vf.value}
                onValueChange={(value) => updateValueFilter(index, { value })}
                className="h-8 text-xs flex-1"
              />
              {vf.operator === 'between' && (
                <Input
                  type="number"
                  value={vf.value2 ?? ''}
                  onChange={(e) => updateValueFilter(index, { value2: e.target.value ? Number(e.target.value) : undefined })}
                  className="h-8 text-xs flex-1"
                />
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => removeValueFilter(index)}
              >
                <X size={12} />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm-tight"
            onClick={addValueFilter}
          >
            <Plus size={10} />
            {t('cohorts.concept_add_value_filter')}
          </Button>
        </CollapsibleContent>
      </Collapsible>

      {/* Occurrence count (collapsible) */}
      <Collapsible open={occurrenceOpen} onOpenChange={setOccurrenceOpen}>
        <div className="flex items-center gap-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
            <ChevronRight className={`size-3.5 transition-transform ${occurrenceOpen ? 'rotate-90' : ''}`} />
            {t('cohorts.concept_occurrence')}
          </CollapsibleTrigger>
          <FieldInfo text={t('cohorts.concept_occurrence_hint')} />
        </div>
        <CollapsibleContent className="pt-2 pl-5">
          <div className="flex gap-2">
            <Select
              value={config.occurrenceCount?.operator ?? '>='}
              onValueChange={(op) =>
                onChange({
                  ...config,
                  occurrenceCount: {
                    operator: op as (typeof COUNT_OPERATORS)[number],
                    count: config.occurrenceCount?.count ?? 1,
                  },
                })
              }
            >
              <SelectTrigger className="h-8 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUNT_OPERATORS.map((op) => (
                  <SelectItem key={op} value={op} className="text-xs">
                    {op}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <NumberInput
              value={config.occurrenceCount?.count ?? 1}
              onValueChange={(count) =>
                onChange({
                  ...config,
                  occurrenceCount: {
                    operator: config.occurrenceCount?.operator ?? '>=',
                    count,
                  },
                })
              }
              className="h-8 text-xs flex-1"
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
