import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ShieldCheck, Database } from 'lucide-react'
import { ListPageToolbar, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { cn } from '@/lib/utils'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useDqStore } from '@/stores/dq-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { getStorage } from '@/lib/storage'
import { parseImportZip } from '@/lib/entity-io'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ListPageTemplate } from '../ListPageTemplate'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CreateDqRuleSetDialog } from './CreateDqRuleSetDialog'
import { useDqRuleSetActions } from './use-dq-rule-set-actions'
import type { DqRuleSet } from '@/types'

function scoreColor(score?: number) {
  if (score == null) return ''
  if (score >= 95) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 80) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

export function DqRuleSetListPage() {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const { dqRuleSetsLoaded, loadDqRuleSets, getWorkspaceRuleSets } = useDqStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const dqActions = useDqRuleSetActions()

  useEffect(() => {
    if (!dqRuleSetsLoaded) loadDqRuleSets()
  }, [dqRuleSetsLoaded, loadDqRuleSets])

  const ruleSets = activeWorkspaceId ? getWorkspaceRuleSets(activeWorkspaceId) : []

  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const filteredRuleSets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = q
      ? ruleSets.filter((rs) => `${localized(rs.name, language)} ${localized(rs.description, language)}`.toLowerCase().includes(q))
      : ruleSets
    return applySort(filtered, sort, {
      name: (rs) => localized(rs.name, language),
      createdAt: (rs) => rs.createdAt,
      updatedAt: (rs) => rs.updatedAt,
    })
  }, [ruleSets, searchQuery, sort, language])

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? '—'

  // --- Import ---
  const [conflict, setConflict] = useState<{ name: string; pending: DqRuleSet; pendingChecks: import('@/types').DqCustomCheck[] } | null>(null)

  const doImport = useCallback(async (rs: DqRuleSet, checks: import('@/types').DqCustomCheck[], duplicate: boolean) => {
    const now = new Date().toISOString()
    const id = duplicate ? crypto.randomUUID() : rs.id
    const entity: DqRuleSet = {
      ...rs,
      id,
      workspaceId: activeWorkspaceId ?? rs.workspaceId,
      name: duplicate ? setLocalized(rs.name, language, `${localized(rs.name, language)} (copy)`) : rs.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    }
    if (!duplicate) {
      await getStorage().dqCustomChecks.deleteByRuleSet(rs.id)
      await getStorage().dqRuleSets.delete(rs.id).catch(() => {})
    }
    await getStorage().dqRuleSets.create(entity)
    for (const c of checks) {
      await getStorage().dqCustomChecks.create({
        ...c,
        id: duplicate ? crypto.randomUUID() : c.id,
        ruleSetId: id,
      })
    }
    await loadDqRuleSets()
  }, [activeWorkspaceId, loadDqRuleSets])

  const handleImport = useCallback(async (file: File) => {
    const parsed = await parseImportZip(file)
    const rs = parsed['ruleset.json'] as DqRuleSet | undefined
    if (!rs?.id) return
    const checks = (parsed['checks.json'] ?? []) as import('@/types').DqCustomCheck[]
    const existing = await getStorage().dqRuleSets.getById(rs.id)
    if (existing) {
      setConflict({ name: localized(existing.name, language), pending: rs, pendingChecks: checks })
    } else {
      await doImport(rs, checks, false)
    }
  }, [doImport])

  return (
    <>
    <ImportConflictDialog
      open={!!conflict}
      onOpenChange={(open) => { if (!open) setConflict(null) }}
      existingName={conflict?.name ?? ''}
      onDuplicate={() => { if (conflict) doImport(conflict.pending, conflict.pendingChecks, true); setConflict(null) }}
      onOverwrite={() => { if (conflict) doImport(conflict.pending, conflict.pendingChecks, false); setConflict(null) }}
    />
    <ListPageTemplate<DqRuleSet>
      canEdit={atLeast('editor')}
      canDelete={atLeast('owner')}
      titleKey="data_quality.rs_title"
      descriptionKey="data_quality.rs_description"
      newButtonKey="data_quality.new_rule_set"
      emptyTitleKey="data_quality.no_rule_sets"
      emptyDescriptionKey="data_quality.no_rule_sets_description"
      deleteConfirmTitleKey={dqActions.deleteConfirmTitleKey}
      deleteConfirmDescriptionKey={dqActions.deleteConfirmDescriptionKey}
      emptyIcon={ShieldCheck}
      items={filteredRuleSets}
      toolbar={
        ruleSets.length > 0 ? (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('common.search')}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        ) : undefined
      }
      onNavigate={(id) => navigate(id)}
      onDelete={dqActions.onDelete}
      onExport={dqActions.onExport}
      getGitRemote={dqActions.getGitRemote}
      onSaveGitRemote={dqActions.onSaveGitRemote}
      exportSupportsIncludeData={dqActions.exportSupportsIncludeData}
      syncScope="dq-rule-sets"
      onImport={handleImport}
      renderCardBody={(rs, actionsMenu) => {
        return (
          <div className="min-w-0 flex-1">
            {/* Row 1: icon + title (+ score) + actions — like Projects */}
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                <ShieldCheck size={20} className="text-teal-500" />
              </div>
              <span className="truncate text-sm font-medium">{localized(rs.name, language)}</span>
              {rs.lastScore != null && (
                <span className={cn('shrink-0 font-mono text-xs font-medium', scoreColor(rs.lastScore))}>
                  {rs.lastScore}%
                </span>
              )}
              <div className="ml-auto shrink-0">{actionsMenu}</div>
            </div>
            {/* Description — full-width line below */}
            <div className="mt-2 h-4">
              {localized(rs.description, language) && (
                <TruncatedText text={localized(rs.description, language)} className="text-xs text-muted-foreground" />
              )}
            </div>
            {/* Database — full-width line below */}
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database size={12} className="shrink-0" />
              <span className="truncate">{getSourceName(rs.dataSourceId)}</span>
            </div>
          </div>
        )
      }}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateDqRuleSetDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={dqActions.renderEditDialog}
    />
    </>
  )
}
