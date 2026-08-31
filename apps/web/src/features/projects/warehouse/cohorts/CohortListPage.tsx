import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { Cohort } from '@/types'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { useCohortStore } from '@/stores/cohort-store'
import { useMemo } from 'react'
import { UsersRound, Plus } from 'lucide-react'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { GatedButton } from '@/components/ui/gated-button'
import { Card } from '@/components/ui/card'
import { BulkDeleteAction } from '@/components/ui/bulk-delete-action'
import { useCardSelection } from '@/components/ui/use-card-selection'
import { ListPageToolbar, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
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
import { CohortCard } from './CohortCard'
import { CreateCohortDialog, type CohortFormData } from './CreateCohortDialog'

export function CohortListPage() {
  const { t } = useTranslation()
  const { projectUid: uid, wsUid } = useResolvedParams()
  const { can } = useMyProjectRole(uid)
  const navigate = useNavigate()
  const { addCohort, duplicateCohort, removeCohort, updateCohort } = useCohortStore()
  // Subscribe to the cohorts array itself (not the getProjectCohorts action, whose
  // reference is stable) so the list re-derives when a cohort is added/removed.
  const allCohorts = useCohortStore((s) => s.cohorts)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCohort, setEditingCohort] = useState<Cohort | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Cohort | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)

  const cohorts = useMemo(() => (uid ? allCohorts.filter((c) => c.projectUid === uid) : []), [uid, allCohorts])

  const filteredCohorts = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = !words.length
      ? cohorts
      : cohorts.filter((c) => {
          const haystack = `${c.name} ${c.description ?? ''}`.toLowerCase()
          return words.every((w) => haystack.includes(w))
        })
    return applySort(filtered, sort, {
      name: (c) => c.name,
      createdAt: (c) => c.createdAt,
      updatedAt: (c) => c.updatedAt,
    })
  }, [cohorts, searchQuery, sort])

  const selection = useCardSelection(useMemo(() => filteredCohorts.map((c) => c.id), [filteredCohorts]))

  // Built through `paths` rather than by hand: useResolvedParams returns FULL
  // uids, so a hand-assembled URL carried full ids while the sidebar matches on
  // the shortened ones — which silently dropped the Cohorts highlight.
  const cohortIds = useMemo(() => cohorts.map((c) => c.id), [cohorts])

  const handleCreate = async (data: CohortFormData) => {
    if (!uid) return
    const id = await addCohort({ projectUid: uid, level: 'visit_detail', ...data })
    navigate(paths.cohort(wsUid ?? '', uid, id, [...cohortIds, id]))
  }

  const handleEditSubmit = (data: CohortFormData) => {
    if (editingCohort) updateCohort(editingCohort.id, data)
    setEditingCohort(null)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t('cohorts.list_title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('cohorts.list_description')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {selection.active ? (
              <BulkDeleteAction
                selection={selection}
                canDelete={can('cohorts:delete')}
                names={(id) => filteredCohorts.find((c) => c.id === id)?.name ?? id}
                onDeleteMany={async (ids) => { for (const id of ids) await removeCohort(id) }}
              />
            ) : (
              <GatedButton allowed={can('cohorts:write')} notAllowedReason={t('common.insufficient_permissions')} size="sm" className="gap-1 text-xs" onClick={() => setDialogOpen(true)}>
                <Plus size={14} />
                {t('cohorts.create')}
              </GatedButton>
            )}
          </div>
        </div>

        {cohorts.length > 0 && (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('cohorts.search_placeholder')}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        )}

        {cohorts.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <UsersRound size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('cohorts.no_cohorts')}
              </p>
              <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
                {t('cohorts.no_cohorts_description')}
              </p>
              <GatedButton allowed={can('cohorts:write')} notAllowedReason={t('common.insufficient_permissions')} onClick={() => setDialogOpen(true)} className="mt-4 gap-2">
                <Plus size={16} />
                {t('cohorts.create')}
              </GatedButton>
            </div>
          </Card>
        ) : filteredCohorts.length === 0 ? (
          <div className="mt-6 flex flex-col items-center py-8">
            <UsersRound size={24} className="text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">{t('cohorts.no_results')}</p>
          </div>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {filteredCohorts.map((cohort) => (
              <CohortCard
                key={cohort.id}
                cohort={cohort}
                href={paths.cohort(wsUid ?? '', uid ?? '', cohort.id, cohortIds)}
                onRemove={() => setDeleteTarget(cohort)}
                onEdit={() => setEditingCohort(cohort)}
                onDuplicate={() => { void duplicateCohort(cohort.id) }}
                canEdit={can('cohorts:write')}
                canDelete={can('cohorts:delete')}
                selected={selection.isSelected(cohort.id)}
                onSelectClick={(e) => selection.onCardClick(e, cohort.id)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateCohortDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
        workspaceId={wsUid}
        projectUid={uid}
      />

      <CreateCohortDialog
        open={!!editingCohort}
        onOpenChange={(open) => { if (!open) setEditingCohort(null) }}
        onSubmit={handleEditSubmit}
        editing={editingCohort ? { name: editingCohort.name, description: editingCohort.description, version: editingCohort.version, dataSourceId: editingCohort.dataSourceId } : undefined}
        workspaceId={wsUid}
        projectUid={uid}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohorts.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cohorts.delete_confirm_description', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { if (deleteTarget) removeCohort(deleteTarget.id); setDeleteTarget(null) }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
