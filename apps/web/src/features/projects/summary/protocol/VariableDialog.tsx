import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import type { ProtocolVariable, VariableRole, VariableDataType, AggregateFunction } from '@/types'

const ROLES: VariableRole[] = ['primary_outcome', 'secondary_outcome', 'exposure', 'covariate', 'confounder', 'descriptor']
const DATA_TYPES: VariableDataType[] = ['continuous', 'categorical', 'binary', 'ordinal', 'date', 'text']
const AGG_FUNCTIONS: AggregateFunction[] = ['first', 'last', 'max', 'min', 'mean', 'median', 'presence', 'duration', 'count', 'sum']

interface VariableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  variable: ProtocolVariable | null
  onSave: (variable: ProtocolVariable) => void
  language: string
  workspaceId?: string
}

function emptyVariable(language: string): ProtocolVariable {
  return {
    id: `var-${Date.now()}`,
    name: { [language]: '' },
    conceptSource: 'custom',
    customConceptName: '',
    temporalAnchor: '',
    timeWindow: { start: '', end: '' },
    aggregateFunction: 'first',
    role: 'covariate',
    order: 0,
  }
}

export function VariableDialog({ open, onOpenChange, variable, onSave, language, workspaceId }: VariableDialogProps) {
  const { t } = useTranslation()
  const [form, setForm] = useState<ProtocolVariable>(() => variable ?? emptyVariable(language))

  const { conceptSets, conceptSetsLoaded, loadConceptSets, getWorkspaceConceptSets } = useConceptMappingStore()
  const wsConceptSets = workspaceId ? getWorkspaceConceptSets(workspaceId) : []

  useEffect(() => {
    if (open && !conceptSetsLoaded) loadConceptSets()
  }, [open, conceptSetsLoaded, loadConceptSets])

  useEffect(() => {
    setForm(variable ?? emptyVariable(language))
  }, [variable, language, open])

  const update = (changes: Partial<ProtocolVariable>) => setForm((f) => ({ ...f, ...changes }))

  const handleSave = () => {
    if (!(form.name[language] ?? '').trim() && !form.customConceptName?.trim()) return
    onSave(form)
  }

  const isEdit = !!variable

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('protocol.edit_variable') : t('protocol.add_variable')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-xs font-medium">{t('protocol.variable_name')}</label>
            <Input
              value={form.name[language] ?? ''}
              onChange={(e) => update({ name: { ...form.name, [language]: e.target.value } })}
              className="h-8 text-sm"
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium">{t('protocol.variable_description')}</label>
            <Textarea
              value={form.description ?? ''}
              onChange={(e) => update({ description: e.target.value })}
              className="min-h-[40px] resize-y text-sm"
            />
          </div>

          {/* Concept Source */}
          <div>
            <label className="mb-1 block text-xs font-medium">{t('protocol.variable_concept_source')}</label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="conceptSource"
                  checked={form.conceptSource === 'concept_set'}
                  onChange={() => update({ conceptSource: 'concept_set' })}
                  className="accent-primary"
                />
                {t('protocol.concept_set')}
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="conceptSource"
                  checked={form.conceptSource === 'custom'}
                  onChange={() => update({ conceptSource: 'custom' })}
                  className="accent-primary"
                />
                {t('protocol.custom_concept')}
              </label>
            </div>
          </div>

          {form.conceptSource === 'concept_set' ? (
            <div>
              <label className="mb-1 block text-xs font-medium">{t('protocol.concept_set')}</label>
              {wsConceptSets.length > 0 ? (
                <Select value={form.conceptSetId ?? ''} onValueChange={(v) => update({ conceptSetId: v })}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder={t('protocol.select_concept_set')} />
                  </SelectTrigger>
                  <SelectContent>
                    {wsConceptSets.map((cs) => (
                      <SelectItem key={cs.id} value={cs.id}>{cs.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">{t('protocol.no_concept_sets')}</p>
              )}
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs font-medium">{t('protocol.custom_concept_name')}</label>
              <Input
                value={form.customConceptName ?? ''}
                onChange={(e) => update({ customConceptName: e.target.value })}
                className="h-8 text-sm"
              />
            </div>
          )}

          {/* Unit */}
          <div>
            <label className="mb-1 block text-xs font-medium">{t('protocol.variable_unit')}</label>
            <Input
              value={form.unit ?? ''}
              onChange={(e) => update({ unit: e.target.value })}
              className="h-8 text-sm"
              placeholder="mmHg, µmol/L, ..."
            />
          </div>

          {/* Temporal Anchor */}
          <div>
            <label className="mb-1 block text-xs font-medium">{t('protocol.temporal_anchor')}</label>
            <Input
              value={form.temporalAnchor}
              onChange={(e) => update({ temporalAnchor: e.target.value })}
              placeholder={t('protocol.temporal_anchor_placeholder')}
              className="h-8 text-sm"
            />
          </div>

          {/* Time Window */}
          <div>
            <label className="mb-1 block text-xs font-medium">{t('protocol.time_window')}</label>
            <div className="flex items-center gap-2">
              <Input
                value={form.timeWindow.start}
                onChange={(e) => update({ timeWindow: { ...form.timeWindow, start: e.target.value } })}
                placeholder={t('protocol.time_window_placeholder_start')}
                className="h-8 text-sm"
              />
              <span className="text-muted-foreground">→</span>
              <Input
                value={form.timeWindow.end}
                onChange={(e) => update({ timeWindow: { ...form.timeWindow, end: e.target.value } })}
                placeholder={t('protocol.time_window_placeholder_end')}
                className="h-8 text-sm"
              />
            </div>
          </div>

          {/* Aggregate Function */}
          <div>
            <label className="mb-1 block text-xs font-medium">{t('protocol.aggregate_function')}</label>
            <Select value={form.aggregateFunction} onValueChange={(v) => update({ aggregateFunction: v as AggregateFunction })}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGG_FUNCTIONS.map((agg) => (
                  <SelectItem key={agg} value={agg}>{t(`protocol.agg_${agg}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Role */}
          <div>
            <label className="mb-1 block text-xs font-medium">{t('protocol.variable_role')}</label>
            <Select value={form.role} onValueChange={(v) => update({ role: v as VariableRole })}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{t(`protocol.role_${r}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Data Type */}
          <div>
            <label className="mb-1 block text-xs font-medium">{t('protocol.variable_data_type')}</label>
            <Select value={form.dataType ?? ''} onValueChange={(v) => update({ dataType: (v || undefined) as VariableDataType | undefined })}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {DATA_TYPES.map((dt) => (
                  <SelectItem key={dt} value={dt}>{t(`protocol.dtype_${dt}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={handleSave}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
