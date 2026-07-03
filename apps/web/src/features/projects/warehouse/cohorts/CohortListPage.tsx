import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { Cohort } from '@/types'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { useCohortStore } from '@/stores/cohort-store'
import { UsersRound, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import { CreateCohortDialog } from './CreateCohortDialog'

export function CohortListPage() {
  const { t } = useTranslation()
  const { projectUid: uid, wsUid } = useResolvedParams()
  const navigate = useNavigate()
  const { getProjectCohorts, addCohort, removeCohort, updateCohort } = useCohortStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCohort, setEditingCohort] = useState<Cohort | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Cohort | null>(null)

  const cohorts = uid ? getProjectCohorts(uid) : []
  const basePath = `/workspaces/${wsUid}/projects/${uid}/warehouse/cohorts`

  const handleCreate = async (data: { name: string; description: string }) => {
    if (!uid) return
    const id = await addCohort({ projectUid: uid, level: 'visit_detail', ...data })
    navigate(paths.cohort(wsUid ?? '', uid, id))
  }

  const handleEditSubmit = (data: { name: string; description: string }) => {
    if (editingCohort) updateCohort(editingCohort.id, data)
    setEditingCohort(null)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">
            {t('cohorts.list_title')}
          </h1>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus size={16} />
            {t('cohorts.create')}
          </Button>
        </div>

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
            </div>
          </Card>
        ) : (
          <div className="mt-6 space-y-3">
            {cohorts.map((cohort) => (
              <CohortCard
                key={cohort.id}
                cohort={cohort}
                basePath={basePath}
                onRemove={() => setDeleteTarget(cohort)}
                onEdit={() => setEditingCohort(cohort)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateCohortDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
      />

      <CreateCohortDialog
        open={!!editingCohort}
        onOpenChange={(open) => { if (!open) setEditingCohort(null) }}
        onSubmit={handleEditSubmit}
        editing={editingCohort ? { name: editingCohort.name, description: editingCohort.description } : undefined}
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
