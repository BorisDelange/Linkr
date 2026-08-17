import { usePatientChartStore } from '@/stores/patient-chart-store'
import { PatientBoardEditDialog } from './PatientBoardEditDialog'
import type { PatientDashboard } from '@/types'

export interface PatientBoardActions {
  onDelete: (id: string) => void
  renderEditDialog: (props: { item: PatientDashboard; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
}

/**
 * Shared per-item actions config for a patient board (edit / delete). Used by the
 * header badge menu so it stays behaviourally identical to the list page.
 */
export function usePatientBoardActions(): PatientBoardActions {
  const removeDashboard = usePatientChartStore((s) => s.removeDashboard)

  return {
    onDelete: (id) => removeDashboard(id),
    renderEditDialog: ({ item, onOpenChange }) => (
      <PatientBoardEditDialog item={item} onOpenChange={onOpenChange} />
    ),
    deleteConfirmTitleKey: 'patient_data.delete_board_confirm_title',
    deleteConfirmDescriptionKey: 'patient_data.delete_board_confirm_description',
  }
}
