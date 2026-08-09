import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import { getBadgeClasses, getBadgeStyle } from '@/lib/badge-colors'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import type { BadgeColor, ProjectBadge } from '@/types'

interface BadgeEditorProps {
  value: ProjectBadge[]
  onChange: (next: ProjectBadge[]) => void
  /**
   * Badges already in use on sibling entities of the same kind, offered as one-click
   * suggestions. Pass the raw list — deduping, sorting and hiding the ones already
   * attached happens here.
   */
  suggestions?: ProjectBadge[]
  label?: string
}

/**
 * Badge picker used by every create/edit dialog: the attached chips (removable), the
 * suggestions from sibling entities, and the new-badge input + colour.
 *
 * Extracted from CreateMappingProjectDialog, which was the only dialog with badges; the
 * suggestion list is what makes a workspace converge on a shared vocabulary instead of
 * ten spellings of the same tag, so it is worth carrying to the other entities rather
 * than shipping a bare input.
 */
export function BadgeEditor({ value, onChange, suggestions = [], label }: BadgeEditorProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)

  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState<BadgeColor>('blue')

  /** Attached labels, case-insensitive — the duplicate check and the suggestion filter. */
  const attached = useMemo(
    () => new Set(value.map((b) => localized(b.label, language).toLowerCase())),
    [value, language],
  )

  /** Distinct sibling badges, first-seen colour wins, minus the ones already attached. */
  const available = useMemo(() => {
    const seen = new Map<string, ProjectBadge>()
    for (const b of suggestions) {
      const resolved = localized(b.label, language)
      if (!resolved) continue
      const key = resolved.toLowerCase()
      if (!seen.has(key) && !attached.has(key)) seen.set(key, b)
    }
    return [...seen.values()].sort((a, b) =>
      localized(a.label, language).localeCompare(localized(b.label, language)),
    )
  }, [suggestions, attached, language])

  /** Labels used by a sibling entity — offered as a suggestion, refused as a new badge. */
  const siblingLabels = useMemo(() => {
    const set = new Set<string>()
    for (const b of suggestions) {
      const resolved = localized(b.label, language).toLowerCase()
      if (resolved) set.add(resolved)
    }
    return set
  }, [suggestions, language])

  type Conflict = 'current' | 'other' | null
  const conflictOf = (raw: string): Conflict => {
    const key = raw.trim().toLowerCase()
    if (!key) return null
    if (attached.has(key)) return 'current'
    if (siblingLabels.has(key)) return 'other'
    return null
  }

  /** Only same-entity duplicates are blocked, so a suggestion click always works. */
  const add = (badge: ProjectBadge) => {
    const trimmed = localized(badge.label, language).trim()
    if (!trimmed || attached.has(trimmed.toLowerCase())) return
    onChange([
      ...value,
      { ...badge, id: crypto.randomUUID(), label: setLocalized(badge.label, language, trimmed) },
    ])
    setNewLabel('')
  }

  const trimmed = newLabel.trim()
  const conflict = conflictOf(trimmed)
  const errorKey = conflict === 'current'
    ? 'concept_mapping.badge_duplicate'
    : conflict === 'other' ? 'concept_mapping.badge_used_elsewhere' : null

  return (
    <div className="grid gap-2">
      <Label className="text-xs">{label ?? t('common.badges')}</Label>

      {value.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1.5">
          {value.map((badge) => (
            <span
              key={badge.id}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${getBadgeClasses(badge.color)}`}
              style={getBadgeStyle(badge.color)}
            >
              {localized(badge.label, language)}
              <button
                type="button"
                className="ml-0.5 opacity-60 hover:opacity-100"
                onClick={() => onChange(value.filter((b) => b.id !== badge.id))}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {available.length > 0 && (
        <div className="rounded-md border border-dashed bg-muted/20 p-2">
          <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('concept_mapping.badge_suggestions')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {available.map((badge) => (
              <button
                key={localized(badge.label, language)}
                type="button"
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 ${getBadgeClasses(badge.color)}`}
                style={getBadgeStyle(badge.color)}
                onClick={() => add(badge)}
                title={t('concept_mapping.badge_suggestion_add')}
              >
                <Plus size={10} />
                {localized(badge.label, language)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t('concept_mapping.badge_label_placeholder')}
            className={`h-8 flex-1 ${conflict ? 'border-destructive focus-visible:ring-destructive' : ''}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed && !conflict) {
                e.preventDefault()
                add({ id: '', label: trimmed, color: newColor })
              }
            }}
          />
          <BadgeColorButton value={newColor} onChange={setNewColor} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2"
            disabled={!trimmed || !!conflict}
            onClick={() => add({ id: '', label: trimmed, color: newColor })}
          >
            <Plus size={12} />
          </Button>
        </div>
        {errorKey && <p className="text-[10px] text-destructive">{t(errorKey)}</p>}
      </div>
    </div>
  )
}
