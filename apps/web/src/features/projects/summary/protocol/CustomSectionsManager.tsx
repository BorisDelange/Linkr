import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { MarkdownSectionField } from './MarkdownSectionField'
import type { ProtocolCustomSection, StudyProtocol } from '@/types'

interface CustomSectionsManagerProps {
  protocol: StudyProtocol
  onChange: (changes: Partial<StudyProtocol>) => void
  editing: boolean
  language: string
}

export function CustomSectionsManager({ protocol, onChange, editing, language }: CustomSectionsManagerProps) {
  const { t } = useTranslation()
  const sections = [...protocol.customSections].sort((a, b) => a.order - b.order)

  const handleAdd = () => {
    const section: ProtocolCustomSection = {
      id: `cs-${Date.now()}`,
      title: { [language]: '' },
      content: '',
      order: protocol.customSections.length,
    }
    onChange({ customSections: [...protocol.customSections, section] })
  }

  const handleUpdate = (id: string, changes: Partial<ProtocolCustomSection>) => {
    onChange({ customSections: protocol.customSections.map((s) => s.id === id ? { ...s, ...changes } : s) })
  }

  const handleRemove = (id: string) => {
    onChange({ customSections: protocol.customSections.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i })) })
  }

  if (!editing && sections.length === 0) return null

  return (
    <div className="space-y-4">
      {sections.map((s) => {
        const title = s.title[language] ?? Object.values(s.title)[0] ?? ''

        if (!editing) {
          if (!title && !s.content) return null
          return (
            <div key={s.id}>
              {title && <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>}
              <MarkdownSectionField value={s.content} onChange={() => {}} placeholder="" editing={false} />
            </div>
          )
        }

        return (
          <div key={s.id} className="rounded-lg border p-3">
            <div className="mb-2 flex items-center gap-2">
              <Input
                value={title}
                onChange={(e) => handleUpdate(s.id, { title: { ...s.title, [language]: e.target.value } })}
                placeholder={t('protocol.custom_section_title')}
                className="h-7 text-xs font-medium"
              />
              <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive" onClick={() => handleRemove(s.id)}>
                <X size={12} />
              </Button>
            </div>
            <MarkdownSectionField
              value={s.content}
              onChange={(v) => handleUpdate(s.id, { content: v })}
              placeholder={t('protocol.custom_section_content_placeholder')}
              editing={true}
            />
          </div>
        )
      })}

      {editing && (
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={handleAdd}>
          <Plus size={12} />
          {t('protocol.add_custom_section')}
        </Button>
      )}
    </div>
  )
}
