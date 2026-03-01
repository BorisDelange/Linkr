import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import type { StudyProtocol } from '@/types'

interface ObjectivesSectionProps {
  protocol: StudyProtocol
  onChange: (changes: Partial<StudyProtocol>) => void
  editing: boolean
}

export function ObjectivesSection({ protocol, onChange, editing }: ObjectivesSectionProps) {
  const { t } = useTranslation()
  const objectives = protocol.secondaryObjectives ?? []

  if (!editing) {
    const hasContent = protocol.primaryObjective || objectives.length > 0 || protocol.hypotheses
    if (!hasContent) return null

    return (
      <div className="space-y-3">
        {protocol.primaryObjective && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t('protocol.primary_objective')}</div>
            <p className="text-sm">{protocol.primaryObjective}</p>
          </div>
        )}
        {objectives.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t('protocol.secondary_objectives')}</div>
            <ol className="ml-4 list-decimal space-y-0.5 text-sm">
              {objectives.map((o, i) => <li key={i}>{o}</li>)}
            </ol>
          </div>
        )}
        {protocol.hypotheses && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t('protocol.hypotheses')}</div>
            <p className="text-sm">{protocol.hypotheses}</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('protocol.primary_objective')}</label>
        <Textarea
          value={protocol.primaryObjective ?? ''}
          onChange={(e) => onChange({ primaryObjective: e.target.value })}
          placeholder={t('protocol.primary_objective_placeholder')}
          className="min-h-[60px] resize-y text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('protocol.secondary_objectives')}</label>
        <div className="space-y-1.5">
          {objectives.map((obj, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="shrink-0 text-xs text-muted-foreground">{i + 1}.</span>
              <Input
                value={obj}
                onChange={(e) => {
                  const updated = [...objectives]
                  updated[i] = e.target.value
                  onChange({ secondaryObjectives: updated })
                }}
                className="h-8 text-sm"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => onChange({ secondaryObjectives: objectives.filter((_, j) => j !== i) })}
              >
                <X size={14} />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => onChange({ secondaryObjectives: [...objectives, ''] })}
          >
            <Plus size={12} />
            {t('protocol.add_secondary_objective')}
          </Button>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('protocol.hypotheses')}</label>
        <Textarea
          value={protocol.hypotheses ?? ''}
          onChange={(e) => onChange({ hypotheses: e.target.value })}
          placeholder={t('protocol.hypotheses_placeholder')}
          className="min-h-[60px] resize-y text-sm"
        />
      </div>
    </div>
  )
}
