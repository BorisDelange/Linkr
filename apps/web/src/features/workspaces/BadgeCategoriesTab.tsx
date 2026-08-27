import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Plus, Tag, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import {
  collectWorkspaceBadges,
  countForCategory,
  refreshStoresAfterBadgeRename,
  renameBadgeCategory,
} from '@/lib/badge-category-rename'
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
  const [toRename, setToRename] = useState<{ category: BadgeCategory, renamed: BadgeCategory } | null>(null)
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

  /** Why a name can't be committed, or null when it can. */
  const nameError = (name: string, exceptId?: string): string | null => {
    if (invalidName(name)) return t('badge_categories.name_no_colon')
    if (name.trim() && nameTaken(name, exceptId)) return t('badge_categories.name_exists')
    return null
  }

  const canAdd = !!newName.trim() && !nameError(newName)

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
  const applyRename = async (category: BadgeCategory, renamed: BadgeCategory) => {
    setBusy(true)
    try {
      await renameBadgeCategory(getStorage(), workspace.id, category, renamed)
      await patch(category.id, { name: renamed.name })
      // The cascade wrote straight to storage: without this the open pages keep
      // rendering the badges they loaded on mount, under the old category name.
      await refreshStoresAfterBadgeRename(workspace.id)
      reloadBadges()
    } finally {
      setBusy(false)
    }
  }

  /**
   * A rename rewrites every badge carrying the category, across the workspace.
   * That is not optional — a badge left on the old prefix would stop matching
   * its category entirely — so the dialog confirms the cascade rather than
   * offering to skip it, and only appears when something is actually affected.
   */
  const rename = async (category: BadgeCategory, next: string) => {
    const to = next.trim()
    if (!to || to === localized(category.name, language) || nameError(to, category.id)) return
    const renamed = { ...category, name: setLocalized(category.name, language, to) }
    if (countForCategory(allBadges, category) > 0) {
      setToRename({ category, renamed })
      return
    }
    await applyRename(category, renamed)
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
            const count = countForCategory(allBadges, category)
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
                  error={(draft) => nameError(draft, category.id)}
                  onCommit={(next) => { void rename(category, next) }}
                />
                <CategoryBadge
                  category={name}
                  value={t('badge_categories.sample_value')}
                  color={category.color}
                  size="md"
                />
                <div className="ml-auto flex shrink-0 items-center gap-3">
                  <span className="text-xs text-muted-foreground">
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
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
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
          {nameError(newName) && (
            <p className="text-xs text-destructive">{nameError(newName)}</p>
          )}
        </Card>
      )}

      <AlertDialog open={!!toRename} onOpenChange={(open) => { if (!open) setToRename(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('badge_categories.rename_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('badge_categories.rename_description', {
                from: toRename ? localized(toRename.category.name, language) : '',
                to: toRename ? localized(toRename.renamed.name, language) : '',
                count: toRename ? countForCategory(allBadges, toRename.category) : 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pending = toRename
                setToRename(null)
                if (pending) void applyRename(pending.category, pending.renamed)
              }}
            >
              {t('badge_categories.rename_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!toDelete} onOpenChange={(open) => { if (!open) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('badge_categories.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('badge_categories.delete_description', {
                name: toDelete ? localized(toDelete.name, language) : '',
                count: toDelete ? countForCategory(allBadges, toDelete) : 0,
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
 * Name field with explicit save/cancel rather than a commit on blur — a rename
 * rewrites every badge in the workspace, so it should never fire from clicking
 * away, and a name that is already taken has to say so instead of silently
 * reverting.
 */
function NameInput({
  value,
  disabled,
  error,
  onCommit,
}: {
  value: string
  disabled?: boolean
  /** Why `draft` can't be saved, or null when it can. */
  error: (draft: string) => string | null
  onCommit: (next: string) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])

  const dirty = draft !== value
  const message = dirty ? error(draft) : null
  const canSave = dirty && !!draft.trim() && !message

  const commit = () => { if (canSave) onCommit(draft) }
  const cancel = () => setDraft(value)

  return (
    <div className="shrink-0">
      <div className="relative w-56">
        <Label htmlFor={`cat-${value}`} className="sr-only">{value}</Label>
        <Input
          id={`cat-${value}`}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            else if (e.key === 'Escape') { e.preventDefault(); cancel() }
          }}
          className={`h-8 w-full ${dirty ? 'pr-14' : ''} ${message ? 'border-destructive focus-visible:ring-destructive' : ''}`}
        />
        {dirty && (
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  onClick={cancel}
                  aria-label={t('common.cancel')}
                >
                  <X size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('common.cancel')}</TooltipContent>
            </Tooltip>
            {/* No Tooltip on this one: it is disabled until the draft is valid,
                and a disabled element emits no pointer events, so a Radix tooltip
                would go silent exactly when it is needed. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-primary disabled:opacity-40"
              disabled={disabled || !canSave}
              onClick={commit}
              aria-label={t('common.save')}
              title={t('common.save')}
            >
              <Check size={13} />
            </Button>
          </div>
        )}
      </div>
      {message && <p className="mt-1 text-xs text-destructive">{message}</p>}
    </div>
  )
}
