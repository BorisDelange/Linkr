import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { VariableDialog } from './VariableDialog'
import type { ProtocolVariable, StudyProtocol, LocalizedString } from '@/types'

interface VariablesSectionProps {
  protocol: StudyProtocol
  onChange: (changes: Partial<StudyProtocol>) => void
  editing: boolean
  language: string
  workspaceId?: string
}

export function VariablesSection({ protocol, onChange, editing, language, workspaceId }: VariablesSectionProps) {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingVariable, setEditingVariable] = useState<ProtocolVariable | null>(null)

  const variables = [...protocol.variables].sort((a, b) => a.order - b.order)

  const handleSave = (variable: ProtocolVariable) => {
    if (editingVariable) {
      onChange({ variables: protocol.variables.map((v) => v.id === variable.id ? variable : v) })
    } else {
      onChange({ variables: [...protocol.variables, { ...variable, order: protocol.variables.length }] })
    }
    setEditingVariable(null)
    setDialogOpen(false)
  }

  const handleDelete = (id: string) => {
    onChange({ variables: protocol.variables.filter((v) => v.id !== id).map((v, i) => ({ ...v, order: i })) })
  }

  const getName = (v: ProtocolVariable) => v.name[language] ?? Object.values(v.name)[0] ?? ''

  if (!editing && variables.length === 0) return null

  return (
    <div>
      {variables.length > 0 && (
        <div className="overflow-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.variable_name')}</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.variable_role')}</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.temporal_anchor')}</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.time_window')}</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.aggregate_function')}</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t('protocol.variable_data_type')}</th>
                {editing && <th className="w-16 px-2 py-1.5" />}
              </tr>
            </thead>
            <tbody>
              {variables.map((v) => (
                <tr key={v.id} className="border-b last:border-b-0 hover:bg-accent/30">
                  <td className="px-2 py-1.5 font-medium">
                    {getName(v)}{v.unit ? ` (${v.unit})` : ''}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${getRoleBadgeClasses(v.role)}`}>
                      {t(`protocol.role_${v.role}`)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{v.temporalAnchor}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{v.timeWindow.start} → {v.timeWindow.end}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{t(`protocol.agg_${v.aggregateFunction}`)}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{v.dataType ? t(`protocol.dtype_${v.dataType}`) : ''}</td>
                  {editing && (
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-0.5">
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => { setEditingVariable(v); setDialogOpen(true) }}>
                          <Pencil size={11} />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(v.id)}>
                          <Trash2 size={11} />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 text-xs text-muted-foreground"
          onClick={() => { setEditingVariable(null); setDialogOpen(true) }}
        >
          <Plus size={12} />
          {t('protocol.add_variable')}
        </Button>
      )}

      <VariableDialog
        open={dialogOpen}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingVariable(null) }}
        variable={editingVariable}
        onSave={handleSave}
        language={language}
        workspaceId={workspaceId}
      />
    </div>
  )
}

function getRoleBadgeClasses(role: string): string {
  switch (role) {
    case 'primary_outcome': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    case 'secondary_outcome': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    case 'exposure': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    case 'covariate': return 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400'
    case 'confounder': return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
    case 'descriptor': return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400'
    default: return 'bg-muted text-muted-foreground'
  }
}
