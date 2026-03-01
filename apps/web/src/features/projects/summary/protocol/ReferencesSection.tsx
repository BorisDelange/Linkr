import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { ProtocolReference, StudyProtocol } from '@/types'

interface ReferencesSectionProps {
  protocol: StudyProtocol
  onChange: (changes: Partial<StudyProtocol>) => void
  editing: boolean
}

export function ReferencesSection({ protocol, onChange, editing }: ReferencesSectionProps) {
  const { t } = useTranslation()
  const [newRef, setNewRef] = useState('')
  const refs = [...protocol.references].sort((a, b) => a.order - b.order)

  const handleAdd = () => {
    if (!newRef.trim()) return
    const item: ProtocolReference = {
      id: `ref-${Date.now()}`,
      text: newRef.trim(),
      order: protocol.references.length,
    }
    onChange({ references: [...protocol.references, item] })
    setNewRef('')
  }

  const handleUpdate = (id: string, text: string) => {
    onChange({ references: protocol.references.map((r) => r.id === id ? { ...r, text } : r) })
  }

  const handleRemove = (id: string) => {
    onChange({ references: protocol.references.filter((r) => r.id !== id).map((r, i) => ({ ...r, order: i })) })
  }

  if (!editing && refs.length === 0) return null

  if (!editing) {
    return (
      <ol className="ml-4 list-decimal space-y-0.5 text-sm">
        {refs.map((r) => <li key={r.id}>{r.text}</li>)}
      </ol>
    )
  }

  return (
    <div className="space-y-1.5">
      {refs.map((r, i) => (
        <div key={r.id} className="group flex items-center gap-1.5">
          <span className="shrink-0 text-xs text-muted-foreground">{i + 1}.</span>
          <Input
            value={r.text}
            onChange={(e) => handleUpdate(r.id, e.target.value)}
            className="h-7 text-xs"
          />
          <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" onClick={() => handleRemove(r.id)}>
            <X size={12} />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Input
          value={newRef}
          onChange={(e) => setNewRef(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder={t('protocol.reference_placeholder')}
          className="h-7 text-xs"
        />
        <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={handleAdd} disabled={!newRef.trim()}>
          <Plus size={12} />
        </Button>
      </div>
    </div>
  )
}
