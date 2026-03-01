import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { MarkdownSectionField } from './MarkdownSectionField'
import type { StudyProtocol, StudyType } from '@/types'

const STUDY_TYPES: StudyType[] = [
  'retrospective_cohort', 'prospective_cohort', 'case_control',
  'cross_sectional', 'randomized_controlled_trial',
  'before_after', 'time_series', 'ecological', 'other',
]

interface StudyDesignSectionProps {
  protocol: StudyProtocol
  onChange: (changes: Partial<StudyProtocol>) => void
  editing: boolean
}

export function StudyDesignSection({ protocol, onChange, editing }: StudyDesignSectionProps) {
  const { t } = useTranslation()

  if (!editing) {
    const hasContent = protocol.studyType || protocol.dataSources || protocol.studyPeriodStart || protocol.studyPeriodEnd
    if (!hasContent) return null

    return (
      <div className="space-y-2 text-sm">
        {protocol.studyType && (
          <div className="flex gap-2">
            <span className="text-muted-foreground">{t('protocol.study_type')}:</span>
            <span>{protocol.studyType === 'other' ? protocol.studyTypeOther : t(`protocol.study_type_${protocol.studyType}`)}</span>
          </div>
        )}
        {protocol.isMulticentric !== undefined && (
          <div className="flex gap-2">
            <span className="text-muted-foreground">{t('protocol.multicentric')}:</span>
            <span>{protocol.isMulticentric ? '✓' : '✗'}</span>
          </div>
        )}
        {(protocol.studyPeriodStart || protocol.studyPeriodEnd) && (
          <div className="flex gap-2">
            <span className="text-muted-foreground">{t('protocol.study_period')}:</span>
            <span>{protocol.studyPeriodStart ?? '?'} — {protocol.studyPeriodEnd ?? '?'}</span>
          </div>
        )}
        {protocol.dataSources && (
          <MarkdownSectionField value={protocol.dataSources} onChange={() => {}} placeholder="" editing={false} label={t('protocol.data_sources_description')} />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('protocol.study_type')}</label>
          <Select value={protocol.studyType ?? ''} onValueChange={(v) => onChange({ studyType: v as StudyType })}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder={t('protocol.select_study_type')} />
            </SelectTrigger>
            <SelectContent>
              {STUDY_TYPES.map((st) => (
                <SelectItem key={st} value={st}>{t(`protocol.study_type_${st}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {protocol.studyType === 'other' && (
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('protocol.study_type_other')}</label>
            <Input
              value={protocol.studyTypeOther ?? ''}
              onChange={(e) => onChange({ studyTypeOther: e.target.value })}
              placeholder={t('protocol.study_type_other_placeholder')}
              className="h-8 text-sm"
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Switch
          checked={protocol.isMulticentric ?? false}
          onCheckedChange={(checked) => onChange({ isMulticentric: checked })}
        />
        <label className="text-sm">{t('protocol.multicentric')}</label>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('protocol.study_period')}</label>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={protocol.studyPeriodStart ?? ''}
            onChange={(e) => onChange({ studyPeriodStart: e.target.value })}
            className="h-8 text-sm"
          />
          <span className="text-muted-foreground">—</span>
          <Input
            type="date"
            value={protocol.studyPeriodEnd ?? ''}
            onChange={(e) => onChange({ studyPeriodEnd: e.target.value })}
            className="h-8 text-sm"
          />
        </div>
      </div>

      <MarkdownSectionField
        value={protocol.dataSources ?? ''}
        onChange={(v) => onChange({ dataSources: v })}
        placeholder={t('protocol.data_sources_placeholder')}
        editing={true}
        label={t('protocol.data_sources_description')}
      />
    </div>
  )
}
