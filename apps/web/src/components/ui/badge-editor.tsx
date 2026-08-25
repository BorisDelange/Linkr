import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import { CategoryBadge } from '@/components/ui/category-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EditableBadge } from '@/components/ui/editable-badge'
import { SectionLabel } from '@/components/ui/section-label'
import { getBadgeClasses, getBadgeStyle } from '@/lib/badge-colors'
import { addBadge, categoryOf, joinLabel, joinLocalizedLabel, valueOf } from '@/lib/badge-categories'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import type { BadgeCategory, BadgeColor, LocalizedString, ProjectBadge } from '@/types'

/** Sentinel for "no category": Radix Select forbids an empty-string value. */
const NO_CATEGORY = '__none__'

/**
 * The label minus `lang`, so a rename applies there while the other languages
 * keep the value they were given. A legacy plain string carries no per-language
 * value to keep, so it is dropped whole.
 */
function dropLabel(label: LocalizedString | string, lang: string): LocalizedString {
  if (typeof label === 'string') return {}
  const next = { ...label }
  delete next[lang]
  return next
}

interface BadgeEditorProps {
  value: ProjectBadge[]
  onChange: (next: ProjectBadge[]) => void
  /**
   * Categories declared by the workspace. When non-empty the input grows a
   * category picker, and adding into an exclusive one replaces its current
   * value. Omit (or pass none) and badges stay plain free text.
   */
  categories?: BadgeCategory[]
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
 *
 * Pass the workspace's `categories` to get GitLab-style scoped badges: a picker in
 * front of the input, two-tone chips, and one value per exclusive category.
 */
export function BadgeEditor({ value, onChange, categories = [], suggestions = [], label }: BadgeEditorProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)

  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState<BadgeColor>('blue')
  /** Category the new badge goes into; '' = none (a plain, uncategorized badge). */
  const [newCategoryId, setNewCategoryId] = useState('')
  const newCategory = categories.find((c) => c.id === newCategoryId)

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

  /**
   * Only same-entity duplicates are blocked, so a suggestion click always works.
   * Exclusivity is applied by `addBadge`: adding a second value of an exclusive
   * category replaces the first rather than stacking.
   */
  const add = (badge: ProjectBadge) => {
    const trimmed = localized(badge.label, language).trim()
    if (!trimmed) return
    const next = addBadge(
      value,
      { ...badge, id: crypto.randomUUID(), label: setLocalized(badge.label, language, trimmed) },
      categories,
      language,
    )
    if (next !== value) onChange(next)
    setNewLabel('')
  }

  /**
   * Add the typed text under the picked category, prefixed in every language the
   * category is named in — the prefix is translated, so writing only the active
   * language's spelling would leave the badge unmatchable in the other one.
   */
  const addTyped = () => {
    const text = newLabel.trim()
    if (!text || conflict) return
    if (!newCategory) {
      add({ id: '', label: text, color: newColor })
      return
    }
    add({ id: '', label: joinLocalizedLabel(newCategory, text), color: newCategory.color })
  }

  /** The label the current input would produce, category prefix included. */
  const composed = (raw: string) => {
    const text = raw.trim()
    if (!text || !newCategory) return text
    return joinLabel(localized(newCategory.name, language), text)
  }

  const trimmed = composed(newLabel)
  const conflict = conflictOf(trimmed)
  const errorKey = conflict === 'current'
    ? 'concept_mapping.badge_duplicate'
    : conflict === 'other' ? 'concept_mapping.badge_used_elsewhere' : null

  return (
    <div className="grid gap-2">
      <Label>{label ?? t('common.badges')}</Label>

      {value.length > 0 && (
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          {value.map((badge) => {
            const category = categoryOf(badge, categories, language)
            const remove = () => onChange(value.filter((b) => b.id !== badge.id))
            /** Rewrite this badge's label, keeping its other languages. */
            const relabel = (next: string) => onChange(value.map((b) => (
              b.id === badge.id ? { ...b, label: setLocalized(b.label, language, next) } : b
            )))
            // Renaming a typo shouldn't mean removing the badge and retyping it,
            // categorized or not. A scoped badge renames only its value half —
            // the category is picked, and typing over it would silently move the
            // badge to another one (or out of all of them).
            if (category) {
              // Renaming the value re-prefixes every language of the category, so
              // the badge keeps matching whichever one the UI is showing.
              const renameValue = (next: string) => onChange(value.map((b) => (
                b.id === badge.id
                  ? { ...b, label: joinLocalizedLabel(category, next, dropLabel(b.label, language)) }
                  : b
              )))
              return (
                <CategoryBadge
                  key={badge.id}
                  category={localized(category.name, language)}
                  value={valueOf(badge, categories, language)}
                  color={category.color}
                  size="md"
                  onRemove={remove}
                  onRename={renameValue}
                />
              )
            }
            return (
              <EditableBadge
                key={badge.id}
                label={localized(badge.label, language)}
                color={badge.color}
                onRemove={remove}
                onRename={relabel}
              />
            )
          })}
        </div>
      )}

      {available.length > 0 && (
        <div className="rounded-md border border-dashed bg-muted/20 p-2">
          <SectionLabel as="p" className="mb-1.5 font-normal tracking-wide">
            {t('concept_mapping.badge_suggestions')}
          </SectionLabel>
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
          {categories.length > 0 && (
            <Select
              value={newCategoryId || NO_CATEGORY}
              onValueChange={(v) => setNewCategoryId(v === NO_CATEGORY ? '' : v)}
            >
              <SelectTrigger className="h-8 w-32 shrink-0 text-xs">
                <SelectValue placeholder={t('badge_categories.pick_category')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>{t('badge_categories.no_category')}</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{localized(c.name, language)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            // Enter adds the badge here; the shell must not also submit the form.
            data-no-enter-submit
            placeholder={t('concept_mapping.badge_label_placeholder')}
            className={`h-8 flex-1 ${conflict ? 'border-destructive focus-visible:ring-destructive' : ''}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed && !conflict) {
                e.preventDefault()
                addTyped()
              }
            }}
          />
          {/* A categorized badge wears its category's colour, so the picker
              would only offer a choice that gets overridden. */}
          {!newCategory && <BadgeColorButton value={newColor} onChange={setNewColor} />}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2"
            disabled={!trimmed || !!conflict}
            onClick={addTyped}
          >
            <Plus size={12} />
          </Button>
        </div>
        {errorKey && <p className="text-[10px] text-destructive">{t(errorKey)}</p>}
      </div>
    </div>
  )
}
