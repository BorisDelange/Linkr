import { useDashboardStore } from '@/stores/dashboard-store'
import { DashboardEditDialog } from './DashboardEditDialog'
import type { Dashboard } from '@/types'

export interface DashboardActions {
  onDelete: (id: string) => void
  renderEditDialog: (props: { item: Dashboard; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
}

/**
 * Shared per-item actions config for a dashboard (edit / delete). Used by the
 * header badge menu so it stays behaviourally identical to the list page.
 */
export function useDashboardActions(): DashboardActions {
  const deleteDashboard = useDashboardStore((s) => s.deleteDashboard)

  return {
    onDelete: (id) => deleteDashboard(id),
    renderEditDialog: ({ item, onOpenChange }) => (
      <DashboardEditDialog item={item} onOpenChange={onOpenChange} />
    ),
    deleteConfirmTitleKey: 'dashboard.delete_confirm_title',
    deleteConfirmDescriptionKey: 'dashboard.delete_confirm_description',
  }
}
