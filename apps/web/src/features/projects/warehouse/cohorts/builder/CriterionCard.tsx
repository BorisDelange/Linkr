import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Power, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AgeCriteriaForm } from './criteria/AgeCriteriaForm'
import { SexCriteriaForm } from './criteria/SexCriteriaForm'
import { DeathCriteriaForm } from './criteria/DeathCriteriaForm'
import { PeriodCriteriaForm } from './criteria/PeriodCriteriaForm'
import { DurationCriteriaForm } from './criteria/DurationCriteriaForm'
import { VisitTypeCriteriaForm } from './criteria/VisitTypeCriteriaForm'
import { ConceptCriteriaForm } from './criteria/ConceptCriteriaForm'
import type {
  CriterionNode,
  CriteriaType,
  CriteriaConfig,
  SchemaMapping,
} from '@/types'

interface CriterionCardProps {
  node: CriterionNode
  onUpdate: (id: string, changes: Partial<CriterionNode>) => void
  onRemove: (id: string) => void
  eventTableLabels: string[]
  genderValues?: SchemaMapping['genderValues']
}

function getDefaultConfig(type: CriteriaType): CriteriaConfig {
  switch (type) {
    case 'age':
      return { ageReference: 'admission', min: undefined, max: undefined }
    case 'sex':
      return { values: [] }
    case 'death':
      return { isDead: true }
    case 'period':
      return { startDate: undefined, endDate: undefined }
    case 'duration':
      return { minDays: undefined, maxDays: undefined }
    case 'visit_type':
      return { values: [] }
    case 'concept':
      return { eventTableLabel: '', conceptIds: [], conceptNames: {} }
  }
}

const criteriaTypeKeys: { value: CriteriaType; labelKey: string }[] = [
  { value: 'age', labelKey: 'cohorts.criteria_age' },
  { value: 'sex', labelKey: 'cohorts.criteria_sex' },
  { value: 'death', labelKey: 'cohorts.criteria_death' },
  { value: 'period', labelKey: 'cohorts.criteria_period' },
  { value: 'duration', labelKey: 'cohorts.criteria_duration' },
  { value: 'visit_type', labelKey: 'cohorts.criteria_visit_type' },
  { value: 'concept', labelKey: 'cohorts.criteria_concept' },
]

function CriteriaConfigForm({
  type,
  config,
  onChange,
  eventTableLabels,
  genderValues,
}: {
  type: CriteriaType
  config: CriteriaConfig
  onChange: (config: CriteriaConfig) => void
  eventTableLabels: string[]
  genderValues?: SchemaMapping['genderValues']
}) {
  switch (type) {
    case 'age':
      return <AgeCriteriaForm config={config} onChange={onChange} />
    case 'sex':
      return <SexCriteriaForm config={config} onChange={onChange} genderValues={genderValues} />
    case 'death':
      return <DeathCriteriaForm config={config} onChange={onChange} />
    case 'period':
      return <PeriodCriteriaForm config={config} onChange={onChange} />
    case 'duration':
      return <DurationCriteriaForm config={config} onChange={onChange} />
    case 'visit_type':
      return <VisitTypeCriteriaForm config={config} onChange={onChange} />
    case 'concept':
      return <ConceptCriteriaForm config={config} onChange={onChange} eventTableLabels={eventTableLabels} />
    default:
      return null
  }
}

export function CriterionCard({
  node,
  onUpdate,
  onRemove,
  eventTableLabels,
  genderValues,
}: CriterionCardProps) {
  const { t } = useTranslation()

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  }

  const handleTypeChange = (newType: CriteriaType) => {
    onUpdate(node.id, { type: newType, config: getDefaultConfig(newType) })
  }

  const handleConfigChange = (config: CriteriaConfig) => {
    onUpdate(node.id, { config })
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-lg border bg-muted/30 p-2.5 space-y-2',
        isDragging && 'opacity-50',
        !node.enabled && 'opacity-50',
      )}
    >
      {/* Top row: drag handle, type selector, NOT toggle, enable/disable, remove */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} />
        </button>

        <Select value={node.type} onValueChange={(v) => handleTypeChange(v as CriteriaType)}>
          <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {criteriaTypeKeys.map(({ value, labelKey }) => (
              <SelectItem key={value} value={value} className="text-xs">
                {t(labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1">
          <Switch
            id={`not-${node.id}`}
            checked={node.exclude}
            onCheckedChange={(checked) => onUpdate(node.id, { exclude: checked })}
            className="scale-75"
          />
          <label
            htmlFor={`not-${node.id}`}
            className="text-[10px] font-medium text-muted-foreground cursor-pointer select-none"
          >
            NOT
          </label>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => onUpdate(node.id, { enabled: !node.enabled })}
          title={node.enabled ? t('cohorts.disable') : t('cohorts.enable')}
        >
          <Power size={12} className={node.enabled ? 'text-foreground' : 'text-muted-foreground'} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => onRemove(node.id)}
          title={t('common.remove')}
        >
          <X size={12} />
        </Button>
      </div>

      {/* Config form */}
      <CriteriaConfigForm
        type={node.type}
        config={node.config}
        onChange={handleConfigChange}
        eventTableLabels={eventTableLabels}
        genderValues={genderValues}
      />
    </div>
  )
}
