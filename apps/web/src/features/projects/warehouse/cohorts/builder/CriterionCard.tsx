import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical,
  Power,
  Trash2,
  ChevronDown,
  ChevronRight,
  Cake,
  Calendar,
  Clock,
  HeartOff,
  User,
  Building2,
  Beaker,
  type LucideIcon,
} from 'lucide-react'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { AgeCriteriaForm } from './criteria/AgeCriteriaForm'
import { SexCriteriaForm } from './criteria/SexCriteriaForm'
import { DeathCriteriaForm } from './criteria/DeathCriteriaForm'
import { PeriodCriteriaForm } from './criteria/PeriodCriteriaForm'
import { DurationCriteriaForm } from './criteria/DurationCriteriaForm'
import { CareSiteCriteriaForm } from './criteria/CareSiteCriteriaForm'
import { ConceptCriteriaForm } from './criteria/ConceptCriteriaForm'
import { CohortConceptPickerDialog } from './criteria/CohortConceptPickerDialog'
import type {
  CriterionNode,
  CriteriaType,
  CriteriaConfig,
  AgeCriteriaConfig,
  SexCriteriaConfig,
  DeathCriteriaConfig,
  PeriodCriteriaConfig,
  DurationCriteriaConfig,
  CareSiteCriteriaConfig,
  ConceptCriteriaConfig,
  SchemaMapping,
} from '@/types'

interface CriterionCardProps {
  node: CriterionNode
  onUpdate: (id: string, changes: Partial<CriterionNode>) => void
  onRemove: (id: string) => void
  eventTableLabels: string[]
  genderValues?: SchemaMapping['genderValues']
  visitDateRange?: { minDate: string; maxDate: string }
  dataSourceId?: string
  schemaMapping?: SchemaMapping
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
      return { durationLevel: 'visit', minDays: undefined, maxDays: undefined }
    case 'care_site':
      return { careSiteLevel: 'visit_detail', values: [] }
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
  { value: 'care_site', labelKey: 'cohorts.criteria_care_site' },
  { value: 'concept', labelKey: 'cohorts.criteria_concept' },
]

// --- Icon & color mapping per criteria type ---

interface CriteriaTypeMeta {
  icon: LucideIcon
  color: string
  bgColor: string
  borderColor: string
}

const criteriaTypeMeta: Record<CriteriaType, CriteriaTypeMeta> = {
  age: {
    icon: Cake,
    color: 'text-orange-500 dark:text-orange-400',
    bgColor: 'bg-orange-500/5',
    borderColor: 'border-l-orange-500/50',
  },
  sex: {
    icon: User,
    color: 'text-violet-500 dark:text-violet-400',
    bgColor: 'bg-violet-500/5',
    borderColor: 'border-l-violet-500/50',
  },
  death: {
    icon: HeartOff,
    color: 'text-red-500 dark:text-red-400',
    bgColor: 'bg-red-500/5',
    borderColor: 'border-l-red-500/50',
  },
  period: {
    icon: Calendar,
    color: 'text-amber-500 dark:text-amber-400',
    bgColor: 'bg-amber-500/5',
    borderColor: 'border-l-amber-500/50',
  },
  duration: {
    icon: Clock,
    color: 'text-teal-500 dark:text-teal-400',
    bgColor: 'bg-teal-500/5',
    borderColor: 'border-l-teal-500/50',
  },
  care_site: {
    icon: Building2,
    color: 'text-sky-500 dark:text-sky-400',
    bgColor: 'bg-sky-500/5',
    borderColor: 'border-l-sky-500/50',
  },
  concept: {
    icon: Beaker,
    color: 'text-emerald-500 dark:text-emerald-400',
    bgColor: 'bg-emerald-500/5',
    borderColor: 'border-l-emerald-500/50',
  },
}

// --- Summary builder for collapsed mode ---

function buildSummary(node: CriterionNode, t: (key: string) => string): string {
  const parts: string[] = []

  if (node.exclude) parts.push('NOT')

  switch (node.type) {
    case 'age': {
      const c = node.config as AgeCriteriaConfig
      const ref = c.ageReference === 'admission' ? t('cohorts.age_admission') : t('cohorts.age_current')
      if (c.min != null && c.max != null) {
        parts.push(`${ref} ${c.min}–${c.max}`)
      } else if (c.min != null) {
        parts.push(`${ref} ≥ ${c.min}`)
      } else if (c.max != null) {
        parts.push(`${ref} ≤ ${c.max}`)
      } else {
        parts.push(ref)
      }
      break
    }
    case 'sex': {
      const c = node.config as SexCriteriaConfig
      if (c.values.length > 0) {
        const labels = c.values.map((v) => {
          if (v === '8507') return t('cohorts.sex_male')
          if (v === '8532') return t('cohorts.sex_female')
          return v
        })
        parts.push(labels.join(', '))
      } else {
        parts.push(t('cohorts.criteria_sex'))
      }
      break
    }
    case 'death': {
      const c = node.config as DeathCriteriaConfig
      parts.push(c.isDead ? t('cohorts.death_deceased') : t('cohorts.death_alive'))
      break
    }
    case 'period': {
      const c = node.config as PeriodCriteriaConfig
      if (c.startDate && c.endDate) {
        parts.push(`${c.startDate} → ${c.endDate}`)
      } else if (c.startDate) {
        parts.push(`≥ ${c.startDate}`)
      } else if (c.endDate) {
        parts.push(`≤ ${c.endDate}`)
      } else {
        parts.push(t('cohorts.criteria_period'))
      }
      break
    }
    case 'duration': {
      const c = node.config as DurationCriteriaConfig
      const levelLabel = c.durationLevel === 'visit_detail' ? t('cohorts.level_visit_detail') : t('cohorts.level_visit')
      if (c.minDays != null && c.maxDays != null) {
        parts.push(`${levelLabel}: ${c.minDays}–${c.maxDays} ${t('cohorts.duration_days')}`)
      } else if (c.minDays != null) {
        parts.push(`${levelLabel}: ≥ ${c.minDays} ${t('cohorts.duration_days')}`)
      } else if (c.maxDays != null) {
        parts.push(`${levelLabel}: ≤ ${c.maxDays} ${t('cohorts.duration_days')}`)
      } else {
        parts.push(t('cohorts.criteria_duration'))
      }
      break
    }
    case 'care_site': {
      const c = node.config as CareSiteCriteriaConfig
      parts.push(c.values.length > 0 ? c.values.join(', ') : t('cohorts.criteria_care_site'))
      break
    }
    case 'concept': {
      const c = node.config as ConceptCriteriaConfig
      if (c.conceptIds.length > 0) {
        const names = c.conceptIds.slice(0, 3).map((id) => c.conceptNames[id] ?? String(id))
        const label = names.join(', ')
        parts.push(c.conceptIds.length > 3 ? `${label} (+${c.conceptIds.length - 3})` : label)
      } else if (c.eventTableLabel) {
        parts.push(c.eventTableLabel)
      } else {
        parts.push(t('cohorts.criteria_concept'))
      }
      break
    }
  }

  return parts.join(' ')
}

function CriteriaConfigForm({
  type,
  config,
  onChange,
  eventTableLabels,
  genderValues,
  visitDateRange,
  dataSourceId,
  schemaMapping,
  onOpenConceptPicker,
}: {
  type: CriteriaType
  config: CriteriaConfig
  onChange: (config: CriteriaConfig) => void
  eventTableLabels: string[]
  genderValues?: SchemaMapping['genderValues']
  visitDateRange?: { minDate: string; maxDate: string }
  dataSourceId?: string
  schemaMapping?: SchemaMapping
  onOpenConceptPicker?: () => void
}) {
  switch (type) {
    case 'age':
      return <AgeCriteriaForm config={config} onChange={onChange} />
    case 'sex':
      return <SexCriteriaForm config={config} onChange={onChange} genderValues={genderValues} />
    case 'death':
      return <DeathCriteriaForm config={config} onChange={onChange} />
    case 'period':
      return <PeriodCriteriaForm config={config} onChange={onChange} visitDateRange={visitDateRange} />
    case 'duration':
      return <DurationCriteriaForm config={config} onChange={onChange} />
    case 'care_site':
      return <CareSiteCriteriaForm config={config} onChange={onChange} dataSourceId={dataSourceId} schemaMapping={schemaMapping} />
    case 'concept':
      return <ConceptCriteriaForm config={config} onChange={onChange} eventTableLabels={eventTableLabels} onOpenConceptPicker={onOpenConceptPicker} />
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
  visitDateRange,
  dataSourceId,
  schemaMapping,
}: CriterionCardProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [conceptPickerOpen, setConceptPickerOpen] = useState(false)

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

  const handleConceptPickerConfirm = (conceptIds: number[], conceptNames: Record<number, string>) => {
    const currentConfig = node.config as ConceptCriteriaConfig
    onUpdate(node.id, {
      config: { ...currentConfig, conceptIds, conceptNames },
    })
    setConceptPickerOpen(false)
  }

  const meta = criteriaTypeMeta[node.type]
  const Icon = meta.icon

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'rounded-lg border border-l-[3px] p-2.5 space-y-2',
          meta.bgColor,
          meta.borderColor,
          isDragging && 'opacity-50',
          !node.enabled && 'opacity-40',
        )}
      >
        {/* Top row: drag handle, icon, type selector / summary, controls */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={14} />
          </button>

          {/* Collapse/expand toggle */}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className={cn('shrink-0', meta.color)}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>

          {collapsed ? (
            /* Collapsed: icon + one-line summary */
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
            >
              <Icon size={14} className={cn('shrink-0', meta.color)} />
              <span className="text-xs font-medium truncate">
                {buildSummary(node, t)}
              </span>
            </button>
          ) : (
            /* Expanded: type selector (icons already in dropdown) */
            <Select value={node.type} onValueChange={(v) => handleTypeChange(v as CriteriaType)}>
              <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {criteriaTypeKeys.map(({ value, labelKey }) => {
                  const itemMeta = criteriaTypeMeta[value]
                  const ItemIcon = itemMeta.icon
                  return (
                    <SelectItem key={value} value={value} className="text-xs">
                      <span className="flex items-center gap-1.5">
                        <ItemIcon size={12} className={itemMeta.color} />
                        {t(labelKey)}
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          )}

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
            onClick={() => setDeleteOpen(true)}
            title={t('common.remove')}
          >
            <Trash2 size={12} />
          </Button>
        </div>

        {/* Config form (hidden when collapsed) */}
        {!collapsed && (
          <CriteriaConfigForm
            type={node.type}
            config={node.config}
            onChange={handleConfigChange}
            eventTableLabels={eventTableLabels}
            genderValues={genderValues}
            visitDateRange={visitDateRange}
            dataSourceId={dataSourceId}
            schemaMapping={schemaMapping}
            onOpenConceptPicker={() => setConceptPickerOpen(true)}
          />
        )}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohorts.criterion_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cohorts.criterion_delete_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onRemove(node.id)}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Concept picker dialog */}
      {node.type === 'concept' && (
        <CohortConceptPickerDialog
          open={conceptPickerOpen}
          onOpenChange={setConceptPickerOpen}
          selectedConceptIds={(node.config as ConceptCriteriaConfig).conceptIds}
          onConfirm={handleConceptPickerConfirm}
          dataSourceId={dataSourceId}
          schemaMapping={schemaMapping}
        />
      )}
    </>
  )
}
