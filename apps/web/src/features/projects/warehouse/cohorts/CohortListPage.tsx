import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { Cohort } from '@/types'
import { useCohortStore } from '@/stores/cohort-store'
import { useMemo } from 'react'
import { UsersRound, Plus } from 'lucide-react'
import { GatedButton } from '@/components/ui/gated-button'
import { Card } from '@/components/ui/card'
import { BulkDeleteAction } from '@/components/ui/bulk-delete-action'
import { useCardSelection } from '@/components/ui/use-card-selection'
import { ListPageToolbar } from '@/components/ui/list-page-toolbar'
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { usePersistedSort } from '@/lib/use-persisted-sort'
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
import { ProjectCohortHost, useCohortHost } from './cohort-host'

/** The project's Cohorts page. */
export function CohortListPage() {
  return (
    <ProjectCohortHost>
      <CohortList />
    </ProjectCohortHost>
  )
}

/** The cohort list of whichever host it sits in — a project page, or a database's tab. */
export function CohortList() {
  const { t } = useTranslation()
  const host = useCohortHost()
  const { can } = host
  const navigate = useNavigate()
  const { addCohort, duplicateCohort, removeCohort, updateCohort } = useCohortStore()
  // Subscribe to the cohorts array itself (not the getProjectCohorts action, whose
  // reference is stable) so the list re-derives when a cohort is added/removed.
  const allCohorts = useCohortStore((s) => s.cohorts)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCohort, setEditingCohort] = useState<Cohort | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Cohort | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = usePersistedSort(host.sortKey)
  const language = useAppStore((s) => s.language)

  const cohorts = useMemo(() => allCohorts.filter(host.owns), [host.owns, allCohorts])

  const filteredCohorts = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = !words.length
      ? cohorts
      : cohorts.filter((c) => {
          const haystack =
            `${localized(c.name, language)} ${localized(c.description, language)}`.toLowerCase()
          return words.every((w) => haystack.includes(w))
        })
    return applySort(filtered, sort, {
      name: (c) => localized(c.name, language),
      createdAt: (c) => c.createdAt,
      updatedAt: (c) => c.updatedAt,
    })
  }, [cohorts, searchQuery, sort, language])

  const selection = useCardSelection(useMemo(() => filteredCohorts.map((c) => c.id), [filteredCohorts]))

  const cohortIds = useMemo(() => cohorts.map((c) => c.id), [cohorts])

  const handleCreate = async (data: CohortFormData) => {
    if (!host.owner.projectUid && !host.owner.ownerDataSourceId) return
    const id = await addCohort({ ...host.owner, level: 'visit_detail', ...data })
    navigate(host.cohortPath(id, [...cohortIds, id]))
  }

  const handleEditSubmit = (data: CohortFormData) => {
    if (editingCohort) updateCohort(editingCohort.id, data)
    setEditingCohort(null)
  }

  return (
    <div className="h-full overflow-auto">
      <div className={host.kind === 'project' ? 'mx-auto max-w-4xl px-6 py-10' : 'mx-auto max-w-4xl px-6 pt-2 pb-10'}>
        <div className="flex items-center justify-between gap-4">
          {/* On a database the tab already says "Cohorts": a second page title
              under it would only repeat it. */}
          {host.kind === 'project' ? (
            <div>
              <h1 className="text-2xl font-bold text-foreground">
                {t('cohorts.list_title')}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{t('cohorts.list_description')}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('cohorts.database_list_description')}</p>
          )}
          <div className="flex shrink-0 items-center gap-1">
            {selection.active ? (
              <BulkDeleteAction
                selection={selection}
                canDelete={can('cohorts:delete')}
                names={(id) => localized(filteredCohorts.find((c) => c.id === id)?.name ?? {}, language) || id}
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
                href={host.cohortPath(cohort.id, cohortIds)}
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
        workspaceId={host.workspaceId}
        projectUid={host.owner.projectUid}
        ownerDataSourceId={host.owner.ownerDataSourceId}
      />

      <CreateCohortDialog
        open={!!editingCohort}
        onOpenChange={(open) => { if (!open) setEditingCohort(null) }}
        onSubmit={handleEditSubmit}
        editing={editingCohort ? { id: editingCohort.id, name: editingCohort.name, description: editingCohort.description, version: editingCohort.version, dataSourceId: editingCohort.dataSourceId } : undefined}
        workspaceId={host.workspaceId}
        projectUid={host.owner.projectUid}
        ownerDataSourceId={host.owner.ownerDataSourceId}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohorts.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cohorts.delete_confirm_description', { name: localized(deleteTarget?.name, language) })}
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
