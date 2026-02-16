import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { useCohortStore } from '@/stores/cohort-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { UsersRound, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CohortCard } from './CohortCard'
import { CohortEditorDialog } from './CohortEditorDialog'
import type { Cohort } from '@/types'

export function CohortsPage() {
  const { t } = useTranslation()
  const { uid } = useParams()
  const { getProjectCohorts, removeCohort, executeCohort } = useCohortStore()
  const { getActiveSource } = useDataSourceStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCohort, setEditingCohort] = useState<Cohort | null>(null)

  const cohorts = uid ? getProjectCohorts(uid) : []
  const firstSource = uid ? getActiveSource(uid) : undefined

  const handleEdit = (cohort: Cohort) => {
    setEditingCohort(cohort)
    setDialogOpen(true)
  }

  const handleCreate = () => {
    setEditingCohort(null)
    setDialogOpen(true)
  }

  const handleExecute = async (cohort: Cohort) => {
    if (!firstSource) return
    await executeCohort(cohort.id, firstSource.id, firstSource.schemaMapping)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">
            {t('cohorts.title')}
          </h1>
          <Button onClick={handleCreate}>
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
                onEdit={() => handleEdit(cohort)}
                onRemove={() => removeCohort(cohort.id)}
                onExecute={() => handleExecute(cohort)}
                hasDataSource={!!firstSource}
              />
            ))}
          </div>
        )}
      </div>

      {uid && (
        <CohortEditorDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          projectUid={uid}
          cohort={editingCohort}
          dataSourceId={firstSource?.id}
          schemaMapping={firstSource?.schemaMapping}
        />
      )}
    </div>
  )
}
