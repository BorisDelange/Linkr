import { useCallback } from 'react'
import { useDqStore } from '@/stores/dq-store'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import JSZip from 'jszip'
import { buildDqRuleSetFolder, downloadBlob, slugify } from '@/lib/entity-io'
import { CreateDqRuleSetDialog } from './CreateDqRuleSetDialog'
import type { DqRuleSet, GitRemoteConfig } from '@/types'
import type { EntityDocsAccessors } from '@/components/ui/entity-actions-menu'

export interface DqRuleSetActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: DqRuleSet) => void
  getGitRemote: (item: DqRuleSet) => GitRemoteConfig | null
  onSaveGitRemote: (item: DqRuleSet, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  renderEditDialog: (props: { item: DqRuleSet; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
  docs: EntityDocsAccessors<DqRuleSet>
}

/**
 * Shared per-item actions config for a DQ rule set (delete / export / edit).
 * Used by both the list page cards and the header badge menu so the two stay
 * behaviourally identical.
 */
export function useDqRuleSetActions(): DqRuleSetActions {
  const updateRuleSet = useDqStore((s) => s.updateRuleSet)
  const deleteRuleSet = useDqStore((s) => s.deleteRuleSet)
  const loadDqRuleSets = useDqStore((s) => s.loadDqRuleSets)

  // Same builder the git sync uses. The hand-rolled version wrote `ruleset.json`
  // where the git layout writes `rule-set.json`, so a ZIP export and a push produced
  // two incompatible trees — and it skipped stripInstanceFields and the docs.
  const onExport = useCallback(async (rs: DqRuleSet) => {
    const zip = new JSZip()
    await buildDqRuleSetFolder(zip, '', rs, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${slugify(localized(rs.name, 'en'))}.zip`)
  }, [])

  const onSaveGitRemote = useCallback(async (rs: DqRuleSet, config: GitRemoteConfig | null) => {
    await getStorage().dqRuleSets.update(rs.id, { gitRemoteConfig: config ?? undefined })
    await loadDqRuleSets()
  }, [loadDqRuleSets])

  return {
    onDelete: (id) => deleteRuleSet(id),
    onExport,
    getGitRemote: (rs) => rs.gitRemoteConfig ?? null,
    onSaveGitRemote,
    exportSupportsIncludeData: false,
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateDqRuleSetDialog open onOpenChange={onOpenChange} editingRuleSet={item} />
    ),
    deleteConfirmTitleKey: 'data_quality.delete_rs_title',
    deleteConfirmDescriptionKey: 'data_quality.delete_rs_description',
    docs: {
      getReadme: (e) => e.readme,
      onSaveReadme: (e, readme) => updateRuleSet(e.id, { readme }),
      getLicense: (e) => e.license ?? null,
      onSaveLicense: (e, license) => updateRuleSet(e.id, { license: license ?? undefined }),
      attachmentOwnerType: 'dq-rule-set',
      getWorkspaceId: (e) => e.workspaceId,
    },
  }
}
