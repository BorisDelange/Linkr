import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookMarked, ExternalLink, Loader2, Plus, RefreshCw, Sigma, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
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
import { getStorage } from '@/lib/storage'
import {
  deleteDictionary,
  dictionarySets,
  organizeLooseConceptSets,
  projectsUsing,
} from '@/lib/data-dictionary/dictionaries'
import { useAppStore } from '@/stores/app-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { vocabularyDataSourceIdFor } from '@/lib/vocabulary-library/resolve'
import { resolveConceptSet } from '@/lib/data-dictionary/resolve'
import type { DataDictionary } from '@/types'
import { DictionarySyncDialog } from './DictionarySyncDialog'

interface DataDictionariesTabProps {
  workspaceId: string
  canWrite: boolean
}

/**
 * The workspace's data dictionaries: concept sets with their unit conversions
 * and recommended units, synced from a repository. Every mapping project, the
 * Concepts page and the MCP pick their concept sets here.
 */
export function DataDictionariesTab({ workspaceId, canWrite }: DataDictionariesTabProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const conceptSets = useConceptMappingStore((s) => s.conceptSets)
  const conceptSetsLoaded = useConceptMappingStore((s) => s.conceptSetsLoaded)
  const loadConceptSets = useConceptMappingStore((s) => s.loadConceptSets)
  const mappingProjects = useConceptMappingStore((s) => s.mappingProjects)
  const loadMappingProjects = useConceptMappingStore((s) => s.loadMappingProjects)
  const [dictionaries, setDictionaries] = useState<DataDictionary[] | null>(null)
  const [syncTarget, setSyncTarget] = useState<DataDictionary | 'new' | null>(null)
  const [toDelete, setToDelete] = useState<DataDictionary | null>(null)
  const [organizing, setOrganizing] = useState(false)
  const [resolving, setResolving] = useState<{ id: string; done: number; total: number } | null>(null)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const updateConceptSet = useConceptMappingStore((s) => s.updateConceptSet)
  const vocabularyId = vocabularyDataSourceIdFor({ workspaceId }, dataSources)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    getStorage().dataDictionaries.getByWorkspace(workspaceId)
      .then((list) => setDictionaries([...list].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((err) => { setError(String(err)); setDictionaries([]) })
  }, [workspaceId])

  useEffect(() => {
    reload()
    if (!conceptSetsLoaded) void loadConceptSets()
    void loadMappingProjects()
  }, [reload, conceptSetsLoaded, loadConceptSets, loadMappingProjects])

  const workspaceSets = useMemo(() => conceptSets.filter((s) => s.workspaceId === workspaceId), [conceptSets, workspaceId])
  const dictionaryIds = useMemo(() => new Set((dictionaries ?? []).map((d) => d.id)), [dictionaries])
  const loose = useMemo(() => workspaceSets.filter((s) => !s.dictionaryId || !dictionaryIds.has(s.dictionaryId)), [workspaceSets, dictionaryIds])
  const workspaceProjects = useMemo(() => mappingProjects.filter((p) => p.workspaceId === workspaceId), [mappingProjects, workspaceId])

  const organize = async () => {
    setOrganizing(true)
    setError(null)
    try {
      await organizeLooseConceptSets(workspaceId, loose, t('data_dictionaries.local_name'))
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOrganizing(false)
    }
  }

  /** Resolve every set of a dictionary against the workspace vocabularies. */
  const resolveAll = async (d: DataDictionary) => {
    if (!vocabularyId) return
    const tables = new Set(dataSources.find((ds) => ds.id === vocabularyId)?.schemaMapping?.knownTables ?? [])
    const sets = dictionarySets(workspaceSets, d.id)
    setResolving({ id: d.id, done: 0, total: sets.length })
    setError(null)
    try {
      for (const [i, set] of sets.entries()) {
        await updateConceptSet(set.id, { resolvedConceptIds: await resolveConceptSet(set, vocabularyId, tables) })
        setResolving({ id: d.id, done: i + 1, total: sets.length })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResolving(null)
    }
  }

  const deleting = toDelete ? dictionarySets(workspaceSets, toDelete.id) : []

  return (
    <div className="mx-auto max-w-4xl space-y-4 pt-2">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t('data_dictionaries.description')}</p>
        {canWrite && (
          <Button size="sm" onClick={() => setSyncTarget('new')}>
            <Plus size={14} />
            {t('data_dictionaries.add')}
          </Button>
        )}
      </div>

      {dictionaries === null ? null : dictionaries.length === 0 && loose.length === 0 ? (
        <Card>
          <EmptyState icon={BookMarked} title={t('data_dictionaries.empty_title')} description={t('data_dictionaries.empty_description')} />
        </Card>
      ) : (
        <div className="space-y-2">
          {dictionaries.map((d) => {
            const sets = dictionarySets(workspaceSets, d.id)
            const used = projectsUsing(workspaceProjects, sets).length
            return (
              <Card key={d.id} className="flex flex-row items-center gap-3 px-3 py-2.5">
                <BookMarked size={16} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{d.name}</span>
                    {d.sourceRepo && (
                      <a href={d.sourceRepo.replace(/\.git$/, '')} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        <span className="truncate">{d.sourceRepo.replace(/^https?:\/\//, '')}{d.branch ? ` @ ${d.branch}` : ''}</span>
                        <ExternalLink size={11} className="shrink-0" />
                      </a>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('data_dictionaries.counts', {
                      sets: sets.length,
                      conversions: d.unitConversions?.length ?? 0,
                      units: d.recommendedUnits?.length ?? 0,
                    })}
                    {' · '}
                    {t('data_dictionaries.used_by', { count: used })}
                    {d.syncedAt && ` · ${t('data_dictionaries.synced_on', { date: new Date(d.syncedAt).toLocaleDateString(language) })}`}
                    {d.commit && <span className="font-mono"> ({d.commit.slice(0, 7)})</span>}
                    {' · '}
                    {resolving?.id === d.id
                      ? t('data_dictionaries.resolving', { done: resolving.done, total: resolving.total })
                      : t('data_dictionaries.resolved_count', { resolved: sets.filter((s) => s.resolvedConceptIds).length, total: sets.length })}
                  </p>
                </div>
                {canWrite && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm-tight"
                      variant="outline"
                      disabled={!vocabularyId || resolving !== null || sets.length === 0}
                      title={vocabularyId ? t('data_dictionaries.resolve_hint') : t('data_dictionaries.resolve_needs_vocabularies')}
                      onClick={() => { void resolveAll(d) }}
                    >
                      {resolving?.id === d.id ? <Loader2 size={12} className="animate-spin" /> : <Sigma size={12} />}
                      {t('data_dictionaries.resolve')}
                    </Button>
                    <Button size="sm-tight" variant="outline" onClick={() => setSyncTarget(d)}>
                      <RefreshCw size={12} />
                      {t('data_dictionaries.update')}
                    </Button>
                    <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" aria-label={t('common.delete')} onClick={() => setToDelete(d)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {loose.length > 0 && (
        <div className="space-y-2 pt-2">
          <SectionLabel as="h3">{t('data_dictionaries.loose_title')}</SectionLabel>
          <Card className="flex flex-row items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t('data_dictionaries.loose_description', { count: loose.length })}</span>
            {canWrite && (
              <Button size="sm-tight" variant="outline" disabled={organizing} onClick={() => { void organize() }}>
                {organizing && <Loader2 size={12} className="animate-spin" />}
                {t('data_dictionaries.loose_organize')}
              </Button>
            )}
          </Card>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <DictionarySyncDialog
        open={syncTarget !== null}
        onOpenChange={(open) => { if (!open) setSyncTarget(null) }}
        workspaceId={workspaceId}
        dictionary={syncTarget === 'new' ? null : syncTarget}
        onDone={reload}
      />

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => { if (!open) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_dictionaries.delete_title', { name: toDelete?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('data_dictionaries.delete_description', { count: deleting.length, projects: projectsUsing(workspaceProjects, deleting).length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const d = toDelete
                setToDelete(null)
                if (d) deleteDictionary(d).then(reload).catch((err) => setError(String(err)))
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
