import { useCallback } from 'react'
import { useDqStore } from '@/stores/dq-store'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { exportEntityZip, slugify } from '@/lib/entity-io'
import { CreateDqRuleSetDialog } from './CreateDqRuleSetDialog'
import type { DqRuleSet } from '@/types'

export interface DqRuleSetActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: DqRuleSet) => void
  renderEditDialog: (props: { item: DqRuleSet; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
}

/**
 * Shared per-item actions config for a DQ rule set (delete / export / edit).
 * Used by both the list page cards and the header badge menu so the two stay
 * behaviourally identical.
 */
export function useDqRuleSetActions(): DqRuleSetActions {
  const deleteRuleSet = useDqStore((s) => s.deleteRuleSet)

  const onExport = useCallback(async (rs: DqRuleSet) => {
    const checks = await getStorage().dqCustomChecks.getByRuleSet(rs.id)
    await exportEntityZip(
      [
        { filename: 'ruleset.json', data: rs },
        { filename: 'checks.json', data: checks },
      ],
      `${slugify(localized(rs.name, 'en'))}.zip`,
    )
  }, [])

  return {
    onDelete: (id) => deleteRuleSet(id),
    onExport,
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateDqRuleSetDialog open onOpenChange={onOpenChange} editingRuleSet={item} />
    ),
    deleteConfirmTitleKey: 'data_quality.delete_rs_title',
    deleteConfirmDescriptionKey: 'data_quality.delete_rs_description',
  }
}
