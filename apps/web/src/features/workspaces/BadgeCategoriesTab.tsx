import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Tag, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import { CategoryBadge } from '@/components/ui/category-badge'
import { SectionLabel } from '@/components/ui/section-label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { collectWorkspaceBadges, countForCategory, renameBadgeCategory } from '@/lib/badge-category-rename'
import { getStorage } from '@/lib/storage'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { BadgeCategory, BadgeColor, ProjectBadge, Workspace } from '@/types'

interface BadgeCategoriesTabProps {
  workspace: Workspace
  canWrite: boolean
}

/**
 * The workspace's badge categories — GitLab's scoped labels.
 *
 * A category is a naming convention, not a container: badges keep the whole
 * `Category::value` string in their own label. That is why renaming one has to
 * rewrite every badge in the workspace (otherwise they'd all keep the old
 * prefix and match nothing), while deleting one rewrites nothing at all — the
 * badges simply stop rendering two-tone.
 */
export function BadgeCategoriesTab({ workspace, canWrite }: BadgeCategoriesTabProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const updateBadgeCategories = useWorkspaceStore((s) => s.updateBadgeCategories)

  const categories = useMemo(() => workspace.badgeCategories ?? [], [workspace.badgeCategories])

  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<BadgeColor>('blue')
  const [toDelete, setToDelete] = useState<BadgeCategory | null>(null)
  const [busy, setBusy] = useState(false)

  // Every badge in the workspace, for the "used by N badges" counts. Read from
  // storage rather than the stores: the entities live in seven of them.
  const [allBadges, setAllBadges] = useState<ProjectBadge[]>([])
  const reloadBadges = useCallback(() => {
    void collectWorkspaceBadges(getStorage(), workspace.id).then(setAllBadges)
  }, [workspace.id])
  useEffect(reloadBadges, [reloadBadges])

  const nameTaken = (name: string, exceptId?: string) =>
    categories.some((c) => c.id !== exceptId && localized(c.name, language).toLowerCase() === name.trim().toLowerCase())

  const invalidName = (name: string) => name.includes(':')

  const canAdd = !!newName.trim() && !nameTaken(newName) && !invalidName(newName)

  const add = async () => {
    if (!canAdd) return
    await updateBadgeCategories(workspace.id, [
      ...categories,
      {
        id: crypto.randomUUID(),
        name: setLocalized({}, language, newName.trim()),
        color: newColor,
        exclusive: false,
      },
    ])
    setNewName('')
  }

  const patch = (id: string, changes: Partial<BadgeCategory>) =>
    updateBadgeCategories(workspace.id, categories.map((c) => (c.id === id ? { ...c, ...changes } : c)))

  /** Renaming rewrites the badges first, so none is left on the old prefix. */
  const rename = async (category: BadgeCategory, next: string) => {
    const from = localized(category.name, language)
    const to = next.trim()
    if (!to || to === from || nameTaken(to, category.id) || invalidName(to)) return
    setBusy(true)
    try {
      await renameBadgeCategory(getStorage(), workspace.id, from, to, language)
      await patch(category.id, { name: setLocalized(category.name, language, to) })
      reloadBadges()
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!toDelete) return
    await updateBadgeCategories(workspace.id, categories.filter((c) => c.id !== toDelete.id))
    setToDelete(null)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 pt-2">
      <p className="text-sm text-muted-foreground">{t('badge_categories.description')}</p>

      {categories.length === 0 ? (
        <Card className="flex flex-col items-center py-10">
          <Tag size={24} className="text-muted-foreground/40" />
          <p className="mt-2 text-sm text-muted-foreground">{t('badge_categories.empty')}</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {categories.map((category) => {
            const name = localized(category.name, language)
            const count = countForCategory(allBadges, name, language)
            return (
              <Card key={category.id} className="flex flex-row items-center gap-3 px-3 py-2.5">
                <BadgeColorButton
                  value={category.color}
                  onChange={(color) => { void patch(category.id, { color }) }}
                  disabled={!canWrite}
                />
                <NameInput
                  value={name}
                  disabled={!canWrite || busy}
                  onCommit={(next) => { void rename(category, next) }}
                />
                <CategoryBadge
                  category={name}
                  value={t('badge_categories.sample_value')}
                  color={category.color}
                  size="md"
                />
                <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">
                  {t('badge_categories.used_by', { count })}
                </span>
                <label className="flex shrink-0 items-center gap-1.5">
                  <Switch
                    checked={category.exclusive}
                    onCheckedChange={(exclusive) => { void patch(category.id, { exclusive }) }}
                    disabled={!canWrite}
                  />
                  <span className="text-xs text-muted-foreground">{t('badge_categories.exclusive')}</span>
                </label>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!canWrite}
                  onClick={() => setToDelete(category)}
                  className="shrink-0 text-destructive hover:text-destructive"
                >
                  <Trash2 size={14} />
                </Button>
              </Card>
            )
          })}
        </div>
      )}

      {canWrite && (
        <Card className="gap-2 p-3">
          <SectionLabel as="p">{t('badge_categories.add')}</SectionLabel>
          <div className="flex items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('badge_categories.name_placeholder')}
              className="h-8 flex-1"
              onKeyDown={(e) => { if (e.key === 'Enter' && canAdd) { e.preventDefault(); void add() } }}
            />
            <BadgeColorButton value={newColor} onChange={setNewColor} />
            <Button variant="outline" size="sm" className="h-8 gap-1" disabled={!canAdd} onClick={() => { void add() }}>
              <Plus size={14} />
              {t('common.add')}
            </Button>
          </div>
          {invalidName(newName) && (
            <p className="text-xs text-destructive">{t('badge_categories.name_no_colon')}</p>
          )}
          {!!newName.trim() && nameTaken(newName) && (
            <p className="text-xs text-destructive">{t('badge_categories.name_exists')}</p>
          )}
        </Card>
      )}

      <AlertDialog open={!!toDelete} onOpenChange={(open) => { if (!open) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('badge_categories.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('badge_categories.delete_description', {
                name: toDelete ? localized(toDelete.name, language) : '',
                count: toDelete ? countForCategory(allBadges, localized(toDelete.name, language), language) : 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { void remove() }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * Name field that commits on blur or Enter rather than per keystroke — a rename
 * rewrites every badge in the workspace, which is not something to do per letter.
 */
function NameInput({
  value,
  disabled,
  onCommit,
}: {
  value: string
  disabled?: boolean
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])

  const commit = () => {
    if (draft.trim() && draft !== value) onCommit(draft)
    else setDraft(value)
  }

  return (
    <>
      <Label htmlFor={`cat-${value}`} className="sr-only">{value}</Label>
      <Input
        id={`cat-${value}`}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
          else if (e.key === 'Escape') { setDraft(value); e.currentTarget.blur() }
        }}
        className="h-8 w-44 shrink-0"
      />
    </>
  )
}
