import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useCohortStore } from '@/stores/cohort-store'
import { buildCohortQuery } from '@/lib/duckdb/cohort-query'
import * as engine from '@/lib/duckdb/engine'
import { Plus, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AgeCriteriaForm } from './criteria/AgeCriteriaForm'
import { SexCriteriaForm } from './criteria/SexCriteriaForm'
import { PeriodCriteriaForm } from './criteria/PeriodCriteriaForm'
import { DurationCriteriaForm } from './criteria/DurationCriteriaForm'
import { ConceptCriteriaForm } from './criteria/ConceptCriteriaForm'
import type {
  Cohort,
  CohortLevel,
  CohortCriteria,
  CriteriaType,
  CriteriaConfig,
  SchemaMapping,
} from '@/types'

interface CohortEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
  cohort: Cohort | null
  dataSourceId?: string
  schemaMapping?: SchemaMapping
}

const levelOptions: { value: CohortLevel; labelKey: string }[] = [
  { value: 'patient', labelKey: 'subsets.level_patient' },
  { value: 'visit', labelKey: 'subsets.level_visit' },
]

function getDefaultConfig(type: CriteriaType): CriteriaConfig {
  switch (type) {
    case 'age':
      return { min: undefined, max: undefined }
    case 'sex':
      return { values: [] }
    case 'period':
      return { startDate: undefined, endDate: undefined }
    case 'duration':
      return { minDays: undefined, maxDays: undefined }
    case 'concept':
      return { domain: '', conceptSetId: '' }
  }
}

function CriteriaConfigForm({
  type,
  config,
  onChange,
  genderValues,
}: {
  type: CriteriaType
  config: CriteriaConfig
  onChange: (config: CriteriaConfig) => void
  genderValues?: SchemaMapping['genderValues']
}) {
  switch (type) {
    case 'age':
      return <AgeCriteriaForm config={config} onChange={onChange} />
    case 'sex':
      return <SexCriteriaForm config={config} onChange={onChange} genderValues={genderValues} />
    case 'period':
      return <PeriodCriteriaForm config={config} onChange={onChange} />
    case 'duration':
      return <DurationCriteriaForm config={config} onChange={onChange} />
    case 'concept':
      return <ConceptCriteriaForm />
    default:
      return null
  }
}

export function CohortEditorDialog({
  open,
  onOpenChange,
  projectUid,
  cohort,
  dataSourceId,
  schemaMapping,
}: CohortEditorDialogProps) {
  const { t } = useTranslation()
  const { addCohort, updateCohort } = useCohortStore()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [level, setLevel] = useState<CohortLevel>('patient')
  const [criteria, setCriteria] = useState<CohortCriteria[]>([])
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(false)

  const isEditing = !!cohort

  useEffect(() => {
    if (open) {
      if (cohort) {
        setName(cohort.name)
        setDescription(cohort.description)
        setLevel(cohort.level)
        setCriteria(cohort.criteria.map((c) => ({ ...c })))
      } else {
        setName('')
        setDescription('')
        setLevel('patient')
        setCriteria([])
      }
      setPreviewCount(null)
      setPreviewLoading(false)
      setPreviewError(false)
    }
  }, [open, cohort])

  const runPreview = useCallback(async () => {
    if (!dataSourceId || criteria.length === 0) {
      setPreviewCount(null)
      return
    }
    setPreviewLoading(true)
    setPreviewError(false)
    try {
      const tempCohort: Cohort = {
        id: 'preview',
        projectUid,
        name: '',
        description: '',
        level,
        criteria,
        createdAt: '',
        updatedAt: '',
      }
      if (!schemaMapping) return
      const sql = buildCohortQuery(tempCohort, schemaMapping)
      if (!sql) return
      const results = await engine.queryDataSource(dataSourceId, sql)
      setPreviewCount(Number(results[0]?.cnt ?? 0))
    } catch {
      setPreviewError(true)
      setPreviewCount(null)
    } finally {
      setPreviewLoading(false)
    }
  }, [dataSourceId, criteria, level, projectUid, schemaMapping])

  const handleSubmit = async () => {
    if (!name.trim()) return
    if (isEditing && cohort) {
      await updateCohort(cohort.id, { name, description, level, criteria })
    } else {
      await addCohort({ projectUid, name, description, level, criteria })
    }
    onOpenChange(false)
  }

  const addCriterion = () => {
    setCriteria([
      ...criteria,
      {
        id: crypto.randomUUID(),
        type: 'age',
        config: getDefaultConfig('age'),
        exclude: false,
      },
    ])
  }

  const removeCriterion = (index: number) => {
    setCriteria(criteria.filter((_, i) => i !== index))
  }

  const updateCriterionType = (index: number, type: CriteriaType) => {
    setCriteria(
      criteria.map((c, i) =>
        i === index ? { ...c, type, config: getDefaultConfig(type) } : c,
      ),
    )
  }

  const updateCriterionConfig = (index: number, config: CriteriaConfig) => {
    setCriteria(
      criteria.map((c, i) => (i === index ? { ...c, config } : c)),
    )
  }

  const toggleCriterionExclude = (index: number) => {
    setCriteria(
      criteria.map((c, i) => (i === index ? { ...c, exclude: !c.exclude } : c)),
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t('subsets.editor_title_edit') : t('subsets.editor_title')}
          </DialogTitle>
          <DialogDescription>{t('subsets.editor_description')}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-5 py-2">
          {/* Name */}
          <div className="space-y-1.5">
            <Label>{t('subsets.field_name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('subsets.field_name_placeholder')}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label>{t('subsets.field_description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('subsets.field_description_placeholder')}
            />
          </div>

          {/* Level selector */}
          <div className="space-y-1.5">
            <Label>{t('subsets.field_level')}</Label>
            <p className="text-xs text-muted-foreground">{t('subsets.field_level_description')}</p>
            <div className="flex gap-2 mt-1.5">
              {levelOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setLevel(opt.value)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                    level === opt.value
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Criteria */}
          <div className="space-y-3">
            <Label>{t('subsets.criteria_title')}</Label>

            {criteria.map((criterion, index) => (
              <div
                key={criterion.id}
                className="rounded-lg border bg-muted/30 p-3 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={criterion.type}
                    onValueChange={(v) => updateCriterionType(index, v as CriteriaType)}
                  >
                    <SelectTrigger className="h-8 text-xs flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="age">{t('subsets.criteria_age')}</SelectItem>
                      <SelectItem value="sex">{t('subsets.criteria_sex')}</SelectItem>
                      <SelectItem value="period">{t('subsets.criteria_period')}</SelectItem>
                      <SelectItem value="duration">{t('subsets.criteria_duration')}</SelectItem>
                      <SelectItem value="concept" disabled>
                        {t('subsets.criteria_concept')}
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  <div className="flex items-center gap-1.5">
                    <Switch
                      id={`exclude-${criterion.id}`}
                      checked={criterion.exclude}
                      onCheckedChange={() => toggleCriterionExclude(index)}
                      className="scale-75"
                    />
                    <Label
                      htmlFor={`exclude-${criterion.id}`}
                      className="text-xs text-muted-foreground cursor-pointer"
                    >
                      {t('subsets.criteria_exclude')}
                    </Label>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeCriterion(index)}
                  >
                    <X size={14} />
                  </Button>
                </div>

                <CriteriaConfigForm
                  type={criterion.type}
                  config={criterion.config}
                  onChange={(config) => updateCriterionConfig(index, config)}
                  genderValues={schemaMapping?.genderValues}
                />
              </div>
            ))}

            <Button
              variant="outline"
              size="sm"
              onClick={addCriterion}
              className="gap-1.5 text-xs w-full"
            >
              <Plus size={12} />
              {t('subsets.criteria_add')}
            </Button>
          </div>

          {/* Preview */}
          {dataSourceId && criteria.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={runPreview}
                disabled={previewLoading}
                className="gap-1.5 text-xs"
              >
                {previewLoading ? <Loader2 size={12} className="animate-spin" /> : <span className="h-3 w-3 rounded-full bg-emerald-500" />}
                {previewLoading
                  ? t('subsets.preview_computing')
                  : previewError
                    ? t('subsets.preview_error')
                    : previewCount != null
                      ? t('subsets.preview_count', { count: previewCount })
                      : t('subsets.execute')}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim()}>
            {isEditing ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
