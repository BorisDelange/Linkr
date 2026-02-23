import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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
import type { ConceptCriteriaConfig } from '@/types'

interface ConceptCriteriaFormProps {
  config: ConceptCriteriaConfig
  onChange: (config: ConceptCriteriaConfig) => void
  eventTableLabels: string[]
}

const VALUE_OPERATORS = ['>', '>=', '=', '<=', '<', '!=', 'between'] as const
const COUNT_OPERATORS = ['>=', '>', '=', '<=', '<'] as const

export function ConceptCriteriaForm({ config, onChange, eventTableLabels }: ConceptCriteriaFormProps) {
  const { t } = useTranslation()
  const [valueFilterOpen, setValueFilterOpen] = useState(!!config.valueFilter)
  const [occurrenceOpen, setOccurrenceOpen] = useState(!!config.occurrenceCount)
  const [timeWindowOpen, setTimeWindowOpen] = useState(!!config.timeWindow)

  const removeConcept = (conceptId: number) => {
    const conceptIds = config.conceptIds.filter((id) => id !== conceptId)
    const conceptNames = { ...config.conceptNames }
    delete conceptNames[conceptId]
    onChange({ ...config, conceptIds, conceptNames })
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

      {/* Selected concepts */}
      <div className="space-y-1">
        <Label className="text-xs">
          {t('cohorts.concept_selected')} ({config.conceptIds.length})
        </Label>
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
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            {t('cohorts.concept_selected')}...
          </p>
        )}
      </div>

      {/* Value filter (collapsible) */}
      <Collapsible open={valueFilterOpen} onOpenChange={setValueFilterOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
          <ChevronRight className={`size-3.5 transition-transform ${valueFilterOpen ? 'rotate-90' : ''}`} />
          {t('cohorts.concept_value_filter')}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 pl-5 space-y-2">
          <div className="flex gap-2">
            <Select
              value={config.valueFilter?.operator ?? '>'}
              onValueChange={(op) =>
                onChange({
                  ...config,
                  valueFilter: {
                    operator: op as (typeof VALUE_OPERATORS)[number],
                    value: config.valueFilter?.value ?? 0,
                    value2: config.valueFilter?.value2,
                  },
                })
              }
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
              value={config.valueFilter?.value ?? ''}
              onChange={(e) =>
                onChange({
                  ...config,
                  valueFilter: {
                    operator: config.valueFilter?.operator ?? '>',
                    value: e.target.value ? Number(e.target.value) : 0,
                    value2: config.valueFilter?.value2,
                  },
                })
              }
              className="h-8 text-xs flex-1"
            />
            {config.valueFilter?.operator === 'between' && (
              <Input
                type="number"
                value={config.valueFilter?.value2 ?? ''}
                onChange={(e) =>
                  onChange({
                    ...config,
                    valueFilter: {
                      ...config.valueFilter!,
                      value2: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
                className="h-8 text-xs flex-1"
              />
            )}
          </div>
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
        </CollapsibleContent>
      </Collapsible>

      {/* Time window (collapsible) */}
      <Collapsible open={timeWindowOpen} onOpenChange={setTimeWindowOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
          <ChevronRight className={`size-3.5 transition-transform ${timeWindowOpen ? 'rotate-90' : ''}`} />
          {t('cohorts.concept_time_window')}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 pl-5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">{t('cohorts.concept_days_before')}</Label>
              <Input
                type="number"
                value={config.timeWindow?.daysBefore ?? ''}
                onChange={(e) =>
                  onChange({
                    ...config,
                    timeWindow: {
                      ...config.timeWindow,
                      daysBefore: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
                placeholder="0"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('cohorts.concept_days_after')}</Label>
              <Input
                type="number"
                value={config.timeWindow?.daysAfter ?? ''}
                onChange={(e) =>
                  onChange({
                    ...config,
                    timeWindow: {
                      ...config.timeWindow,
                      daysAfter: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
                placeholder="0"
                className="h-8 text-xs"
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
