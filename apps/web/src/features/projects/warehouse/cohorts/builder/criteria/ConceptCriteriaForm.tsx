import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, X, Plus, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
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
import type { ConceptCriteriaConfig, ValueFilter } from '@/types'

interface ConceptCriteriaFormProps {
  config: ConceptCriteriaConfig
  onChange: (config: ConceptCriteriaConfig) => void
  eventTableLabels: string[]
  onOpenConceptPicker?: () => void
}

const VALUE_OPERATORS = ['>', '>=', '=', '<=', '<', '!=', 'between'] as const
const COUNT_OPERATORS = ['>=', '>', '=', '<=', '<'] as const

export function ConceptCriteriaForm({ config, onChange, eventTableLabels, onOpenConceptPicker }: ConceptCriteriaFormProps) {
  const { t } = useTranslation()
  const [valueFilterOpen, setValueFilterOpen] = useState((config.valueFilters?.length ?? 0) > 0)
  const [occurrenceOpen, setOccurrenceOpen] = useState(!!config.occurrenceCount)

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
      {/* Event table selector */}
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.concept_event_table')}</Label>
        <Select
          value={config.eventTableLabel}
          onValueChange={(value) => onChange({ ...config, eventTableLabel: value })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {eventTableLabels.map((label) => (
              <SelectItem key={label} value={label} className="text-xs">
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Selected concepts + picker button */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">
            {t('cohorts.concept_selected')} ({config.conceptIds.length})
          </Label>
          {onOpenConceptPicker && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 text-[11px]"
              onClick={onOpenConceptPicker}
            >
              <Search size={10} />
              {t('cohorts.concept_pick')}
            </Button>
          )}
        </div>
        {config.conceptIds.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {config.conceptIds.map((id) => (
              <Badge key={id} variant="secondary" className="gap-1 text-[11px] py-0.5 px-2">
                <span className="truncate max-w-[180px]">
                  {config.conceptNames[id] ?? id}
                </span>
                <button
                  type="button"
                  onClick={() => removeConcept(id)}
                  className="ml-0.5 rounded-full hover:bg-muted-foreground/20"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
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
            <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">
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
              <Input
                type="number"
                value={vf.value ?? ''}
                onChange={(e) => updateValueFilter(index, { value: e.target.value ? Number(e.target.value) : 0 })}
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
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={addValueFilter}
          >
            <Plus size={10} />
            {t('cohorts.concept_add_value_filter')}
          </Button>
        </CollapsibleContent>
      </Collapsible>

      {/* Occurrence count (collapsible) */}
      <Collapsible open={occurrenceOpen} onOpenChange={setOccurrenceOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
          <ChevronRight className={`size-3.5 transition-transform ${occurrenceOpen ? 'rotate-90' : ''}`} />
          {t('cohorts.concept_occurrence')}
        </CollapsibleTrigger>
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
            <Input
              type="number"
              value={config.occurrenceCount?.count ?? ''}
              onChange={(e) =>
                onChange({
                  ...config,
                  occurrenceCount: {
                    operator: config.occurrenceCount?.operator ?? '>=',
                    count: e.target.value ? Number(e.target.value) : 1,
                  },
                })
              }
              className="h-8 text-xs flex-1"
            />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('cohorts.concept_occurrence_hint')}
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
