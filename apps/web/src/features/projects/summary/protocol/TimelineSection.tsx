import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { ProtocolTimelinePhase, StudyProtocol } from '@/types'

interface TimelineSectionProps {
  protocol: StudyProtocol
  onChange: (changes: Partial<StudyProtocol>) => void
  editing: boolean
}

export function TimelineSection({ protocol, onChange, editing }: TimelineSectionProps) {
  const { t } = useTranslation()
  const phases = [...protocol.timelinePhases].sort((a, b) => a.order - b.order)

  const handleAdd = () => {
    const phase: ProtocolTimelinePhase = {
      id: `ph-${Date.now()}`,
      name: '',
      order: protocol.timelinePhases.length,
    }
    onChange({ timelinePhases: [...protocol.timelinePhases, phase] })
  }

  const handleUpdate = (id: string, changes: Partial<ProtocolTimelinePhase>) => {
    onChange({ timelinePhases: protocol.timelinePhases.map((p) => p.id === id ? { ...p, ...changes } : p) })
  }

  const handleRemove = (id: string) => {
    onChange({ timelinePhases: protocol.timelinePhases.filter((p) => p.id !== id).map((p, i) => ({ ...p, order: i })) })
  }

  if (!editing && phases.length === 0) return null

  if (!editing) {
    return (
      <div className="overflow-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.phase_name')}</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.phase_start')}</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.phase_end')}</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.phase_description')}</th>
            </tr>
          </thead>
          <tbody>
            {phases.map((p) => (
              <tr key={p.id} className="border-b last:border-b-0">
                <td className="px-2 py-1.5 font-medium">{p.name}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{p.startDate ?? ''}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{p.endDate ?? ''}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{p.description ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {phases.map((p) => (
        <div key={p.id} className="group flex items-center gap-1.5">
          <Input
            value={p.name}
            onChange={(e) => handleUpdate(p.id, { name: e.target.value })}
            placeholder={t('protocol.phase_name')}
            className="h-7 flex-1 text-xs"
          />
          <Input
            type="date"
            value={p.startDate ?? ''}
            onChange={(e) => handleUpdate(p.id, { startDate: e.target.value })}
            className="h-7 w-32 text-xs"
          />
          <Input
            type="date"
            value={p.endDate ?? ''}
            onChange={(e) => handleUpdate(p.id, { endDate: e.target.value })}
            className="h-7 w-32 text-xs"
          />
          <Input
            value={p.description ?? ''}
            onChange={(e) => handleUpdate(p.id, { description: e.target.value })}
            placeholder={t('protocol.phase_description')}
            className="h-7 flex-1 text-xs"
          />
          <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" onClick={() => handleRemove(p.id)}>
            <X size={12} />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={handleAdd}>
        <Plus size={12} />
        {t('protocol.add_phase')}
      </Button>
    </div>
  )
}
