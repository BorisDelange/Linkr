import { useCohortStore } from '@/stores/cohort-store'
import { CreateCohortDialog } from './CreateCohortDialog'
import type { Cohort } from '@/types'

export interface CohortActions {
  onDelete: (id: string) => void | Promise<void>
  renderEditDialog: (props: { item: Cohort; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
}

/**
 * Shared per-item actions config for a cohort (edit / delete). Used by the
 * header badge menu so it stays behaviourally identical to the list page.
 */
export function useCohortActions(): CohortActions {
  const removeCohort = useCohortStore((s) => s.removeCohort)
  const updateCohort = useCohortStore((s) => s.updateCohort)

  return {
    onDelete: (id) => removeCohort(id),
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateCohortDialog
        open
        onOpenChange={onOpenChange}
        editing={{ name: item.name, description: item.description }}
        onSubmit={(data) => { updateCohort(item.id, data) }}
      />
    ),
    deleteConfirmTitleKey: 'cohorts.delete_confirm_title',
    deleteConfirmDescriptionKey: 'cohorts.delete_confirm_description',
  }
}
