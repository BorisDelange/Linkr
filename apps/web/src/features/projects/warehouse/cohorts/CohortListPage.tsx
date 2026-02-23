import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router'
import { useCohortStore } from '@/stores/cohort-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { UsersRound, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CohortCard } from './CohortCard'
import { CreateCohortDialog } from './CreateCohortDialog'
import type { Cohort, CohortLevel } from '@/types'

export function CohortListPage() {
  const { t } = useTranslation()
  const { uid, wsUid } = useParams()
  const navigate = useNavigate()
  const { getProjectCohorts, addCohort, removeCohort, executeCohort } = useCohortStore()
  const { getActiveSource } = useDataSourceStore()
  const [dialogOpen, setDialogOpen] = useState(false)

  const cohorts = uid ? getProjectCohorts(uid) : []
  const activeSource = uid ? getActiveSource(uid) : undefined
  const basePath = `/workspaces/${wsUid}/projects/${uid}/warehouse/cohorts`

  const handleCreate = async (data: { name: string; description: string; level: CohortLevel }) => {
    if (!uid) return
    const id = await addCohort({ projectUid: uid, ...data })
    navigate(`${basePath}/${id}`)
  }

  const handleExecute = async (cohort: Cohort) => {
    if (!activeSource) return
    await executeCohort(cohort.id, activeSource.id, activeSource.schemaMapping)
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
                onRemove={() => removeCohort(cohort.id)}
                onExecute={() => handleExecute(cohort)}
                hasDataSource={!!activeSource}
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
    </div>
  )
}
